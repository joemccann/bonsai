define([
  '../event_emitter',
  './display_list',
  '../color',
  './timeline',
  '../tools',
  './registry',
  '../asset/asset_loader',
  './environment',
  './ui_event',
  '../uri'
], function(EventEmitter, DisplayList, color, Timeline,
            tools, Registry, AssetLoader, Environment,
            uiEvent, URI) {
  'use strict';

  var hitch = tools.hitch;

  /** @const */
  var DEFAULT_FRAMERATE = 30;

  /**
   * Helper used to collect all descendent IDs of a DisplayList
   * (recursive)
   */
  function collectChildIds(object) {
    var children = object._children,
        ids = [];
    if (children) {
      for (var i = 0, l = children.length; i < l; ++i) {
        if (children[i]) {
          // TODO: why is this check necessary? children should never be falsey.
          ids.push(children[i].id);
          ids.push.apply(ids, collectChildIds(children[i]));
        }
      }
    }
    return ids;
  }

  /**
   * Constructs the movie root, i.e. the global `stage`.
   *
   * @classdesc A Stage instance is the root of your movie. There should never
   *  be a need to instantiate a new Stage from within a movie.
   * @name Stage
   * @constructor
   * @param {Object} messageChannel The messageChannel object used to
   *  communicate with the renderer
   *
   * @mixes EventEmitter
   * @mixes Timeline
   */
  function Stage(messageChannel) {
    var registry = this.registry = new Registry();

    var assetLoader = this.assetLoader =
      new AssetLoader(registry.pendingAssets)
        .on('request', hitch(this, this.loadAsset, null))
        .on('destroy', hitch(this, this.destroyAsset));

    this.env = new Environment(this, assetLoader);
    this.stage = this.root = this;
    this._canRender = true;

    Object.defineProperties(this, {
      id: {value: 0}
    });

    this._queuedFramesById = {};
    this._queuedFrames = [];

    this.messageChannel = messageChannel;
    messageChannel.on('message', this, this.handleEvent);

  }

  Stage.prototype = /** @lends Stage.prototype */ {
    _isFrozen: true,

    assetBaseUrl: new URI(null, null, ''),
    height: Infinity,
    width: Infinity,

    /**
     * Destroys the stage
     *
     * @returns {this} The instance
     */
    destroy: function() {
      clearInterval(this._interval);
      return this;
    },

    /**
     * Freeze/destroy the loop
     */
    freeze: function() {
      clearInterval(this._interval);
      this._isFrozen = true;
      return this;
    },

    /**
     * Handles messages from the client.
     *
     * @private
     * @param {MessageEvent} message
     */
    handleEvent: function(message) {
      var command = message.command,
          data = message.data;

      switch (command) {
        case 'options':
          this.setOptions(data);
          break;
        case 'play':
        case 'stop':
        case 'freeze':
        case 'unfreeze':
          this[command](data);
          break;
        case 'assetLoadSuccess':
          this.assetLoader.handleEvent('load', data.id, data);
          break;
        case 'assetLoadError':
          this.assetLoader.handleEvent('error', data.id, data);
          break;
        case 'userevent':
          var target = data.targetId ? this.registry.displayObjects[data.targetId] : this;
          if (target) { // target might have been removed already
            var event = data.event;
            event.target = target;
            uiEvent(event).emitOn(target);
          }
          break;
        case 'env':
          // Change environment vars
          tools.mixin(this.env.exports.env, data);
          this.env.exports.env.emit('change', data);
          break;
        case 'message':
          this.emit('message', data);
          break;
        case 'canRender':
          this._canRender = true;
          this.postFrames();
          break;
      }
    },

    /**
     * Sends a `loadAsset` message to the renderer
     */
    loadAsset: function(baseUrl, id, request, displayObjectType) {
      // Make asset urls absolute here
      baseUrl = baseUrl || this.assetBaseUrl;
      tools.forEach(request.resources, function(assetResource) {
        var src = URI.parse(assetResource.src);
        if (src.scheme !== 'data') {
          assetResource.src = baseUrl.resolveUri(src).toString();
        }
      });

      this.post({
        command: 'loadAsset',
        data: {
          id: id,
          type: displayObjectType,
          request: request
        }
      });
    },

    /**
     * Sends a `destroyAsset` message to the renderer
     */
    destroyAsset: function(id) {
      this.post({
        command: 'destroyAsset',
        data: { id: id }
      });
    },

    /**
     * Loads a sub movie and runs it in the context of a new Movie object
     * (should be provided by RunnerContext bootstrap)
     *
     * @param movieUrl URL of sub-movie (will use the dirname of the submovie as asset path)
     * @param {Function} callback A callback to be called when your movie has
     *  loaded. The callback will be called with it's first argument signifying
     *  an error. So, if the first argument is `null` you can assume the movie
     *  was loaded successfully.
     */
    loadSubMovie: function() {},

    /**
     * Returns a new Environment for a sub-movie. This is used by loadSubMovie,
     * which is provided by the context's bootstrap code
     *
     * @private
     * @returns {Environment} The Submovie Environment
     */
    getSubMovieEnvironment: function(subMovie, subMovieUrl) {
      subMovieUrl = this.assetBaseUrl.resolveUri(subMovieUrl);
      subMovie.url = subMovieUrl.toString();
      var assetBase = subMovieUrl.scheme === 'data' ? null : subMovieUrl;
      return new Environment(
        subMovie,
        new AssetLoader(this.registry.pendingAssets)
          .on('request', hitch(this, this.loadAsset, assetBase))
      );
    },

    /**
     * Processes DisplayObjects in registry and prepares the message to send
     * to the renderer.
     *
     * When this method is called, it starts another 'tick-cycle'.
     * @private
     */
    loop: function() {

      this.emitFrame();

      var registry = this.registry;
      var movieRegistry = registry.movies;

      var movies = tools.removeValueFromArray(movieRegistry.movies);
      var moviesToIncrement = [this];

      /*
        The `movies` array may contain gaps (if elements are removed from the
        stage during the iteration) and increase its length during the iteration
        (if timelines are added to the stage during iteration)
       */
      var len, movie, i = 0;
      while (i < len  // check whether we are within the cached length
          || i < (len = movies.length)) { // check whether we are within the actual length and cache the length

        movie = movies[i];
        if (movie) {
          movie.emitFrame();
          moviesToIncrement.push(movie);
        }

        i += 1;
      }

      // Emit an event to mark the fact that we've emitted all submovies' frames:
      this.emit('subMoviesAdvanced');

      // Go through all movies and increment their respective frames:
      for (i = 0, len = moviesToIncrement.length; i < len; ++i) {
        moviesToIncrement[i].incrementFrame();
      }

      var message;
      var messagesIndexesById = this._queuedFramesById;
      var queuedFrames = this._queuedFrames;
      var displayObjectRegistry = registry.displayObjects,
          needsDrawRegistry = registry.needsDraw,
          needsInsertionRegistry = registry.needsInsertion;

      for (var id in needsDrawRegistry) {
        var obj = needsDrawRegistry[id];
        var existingMessageIndex = messagesIndexesById[id];

        // if not in display object registry, object has been removed
        if (displayObjectRegistry[id]) {
          message = obj.composeRenderMessage ?
            obj.composeRenderMessage(queuedFrames[existingMessageIndex]) :
            // obj is a pure diplayList style class
            // this poses a problem, as we'll probably need to pass this
            // to the renderer, too.
            message = { id: +id };

          if (id in needsInsertionRegistry) {
            delete needsInsertionRegistry[id];
            var next = obj.next;
            message.next = next && next.id;
            message.parent = obj.parent.id;
          }

          obj.emit('render');

          delete message.detach;
        } else {

          // collect ids of all children (all levels) that are removed together with the parent
          var childIds = collectChildIds(obj);

          message = {id: +id, detach: true};
          if (childIds.length) {
            message.children = childIds;
          }

        }
        delete needsDrawRegistry[id];

        if (existingMessageIndex >= 0) {
          queuedFrames[existingMessageIndex] = message;
        } else {
          messagesIndexesById[id] = queuedFrames.push(message) - 1;
        }
      }

      this.emit('exitFrame');

      this.postFrames();
    },

    /**
     * Sends data to the client.
     *
     * @param data
     * @returns {this} The instance
     */
    post: function(data) {
      this.messageChannel.notifyRenderer(data);
      return this;
    },

    postFrames: function() {
      var queuedFrames = this._queuedFrames;

      if (this._canRender && queuedFrames.length) {
        this._canRender = false;
        this._queuedFramesById = {};
        this._queuedFrames = [];
        this.post({
          command: 'render',
          data: queuedFrames,
          frame: this.currentFrame
        });

      }
    },

    /**
     * Sends a message to the renderer / stage controller
     * @param messageData
     * @returns {this} The instance
     */
    sendMessage: function(messageData) {
      return this.post({command: 'message', data: messageData});
    },

    /**
     * Set the framerate of the movie
     * @param {Number} framerate frames per second
     */
    setFramerate: function(framerate) {

      if (!framerate) {
        return;
      }

      var wasFrozen = this._isFrozen;
      this.freeze();
      this.framerate = Math.abs(framerate | 0);
      if (!wasFrozen) {
        this.unfreeze();
      }
    },
    /**
     * Sets options on the stage
     *
     * @param {Object} options
     * @param {number} [options.framerate=30] Playback speed of the movie
     * @param {string} [options.baseUrl='.'] The base URL to use to resolve urls.
     * @param {string} [options.pluginUrl='.'] The base URL to use to resolve plugin location.
     * @param {Array} [options.plugins] A list of plugin names to load.
     * @returns {this} the stage intance.
     */
    setOptions: function(options) {
      this.options = options;
      this.baseUrl = URI.parse(options.baseUrl);
      this.assetBaseUrl = URI.parse(
        // If assetBaseUrl is not defined then we use the primary
        // movie URL as the assumed base, with a last fallback to baseUrl:
        options.assetBaseUrl || options.url || (options.urls && options.urls[0]) || options.baseUrl
      );
      this.setFramerate(options.framerate || DEFAULT_FRAMERATE);
      this.width = +options.width || Infinity;
      this.height = +options.height || Infinity;

      return this;
    },

    /**
     * Set the technique for rendering, currently only supporting value, 'crispEdges'.
     * @param {String} renderingType 'crispEdges'
     */
    setRendering: function(renderingType) {
      if (renderingType === 'crispEdges') {
        this.post({
          command: 'renderConfig',
          data: {
            item: 'crispEdges',
            value: true
          }
        });
      }
    },

    /**
     * Set the background color of the stage
     */
    setBackgroundColor: function(value) {
      this.post({
        command: 'renderConfig',
        data: {
          item: 'backgroundColor',
          value: color.parse(value)
        }
      });
    },

    /**
     * Unfreeze/initiate the loop
     */
    unfreeze: function() {
      if (this._isFrozen) {
        this._interval = setInterval(hitch(this, this.loop), 1000 / this.framerate);
        this._isFrozen = false;
      }
    }
  };

  tools.mixin(Stage.prototype, EventEmitter, DisplayList, Timeline);

  return Stage;
});
