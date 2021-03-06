const _ = require("lodash");
const Market = require("./market");
const signalr = require("signalr-client");
const EventEmitter = require("events");
const cloudscraper = require("cloudscraper");

const wsURI = "wss://socket.bittrex.com/signalr";
const reconnectWaitTime = 100; //reconnect wait time in ms
const maxCurrenciesPerClient = 10;

class MarketManager extends EventEmitter {
  constructor(replayHistory = false) {
    super();
    this._replayHistory = replayHistory;
    this._setStartValues();
  }

  _setStartValues() {
    this._markets = {};
    this._clientPool = [];
    this._subscribedCount = 0;
    this._currentClient = null;
    this._subscriptionQueue = [];
    this._subscribing = false;
    this._cloudflareBypassReady = false;
    this._cloudflareBypassRequestInFlight = false;
    this._cloudflareUserAgent = null;
    this._cloudflareCookies = null;
    this._cloudflareBypassCallbacksWaiting = [];
    this._ignoredFirstNegotiationError = false;
  }

  _addClient(callback) {
    if (this._subscribedCount != 1 && this._subscribedCount % (maxCurrenciesPerClient + 1) != 0) {
      return callback(this._currentClient);
    }
    console.log("Creating new client", this._subscribedCount, maxCurrenciesPerClient);
    const client = new signalr.client(wsURI, ["CoreHub"], reconnectWaitTime / 1000, true);
    client.wasConnected = false;

    if (this._cloudflareCookies !== null || this.cloudflareCookies !== undefined) {
      client.headers["cookie"] = this._cloudflareCookies;
      client.headers["User-Agent"] = this._cloudflareUserAgent;
    }

    client.currencyPairs = [];

    client.serviceHandlers.reconnected = websocket => {
      _.each(client.currencyPairs, currencyPair => {
        this._subscribePair(currencyPair, client);
      });
    };

    client.serviceHandlers.connected = websocket => {
      if (client.stopping) {
        return;
      }
      console.log("CONNECTED");
      if (!client.wasConnected) {
        client.wasConnected = true;
        callback(client);
      } else {
        client.serviceHandlers.reconnected(websocket);
      }
    };

    client.serviceHandlers.disconnected = websocket => {
      if (client.stopping) {
        return;
      }
      console.log("bittrex disconnected, reconnecting immediately");
      setImmediate(() => {
        console.log("In connect function");
        client.start();
        console.log("Connected");
      });
    };

    client.serviceHandlers.reconnecting = retry => {
      if (client.stopping) {
        return;
      }
      console.log("Bittrex retrying");
      return false;
    };

    client.serviceHandlers.onerror = (errorMessage, e, errorData) => {
      if (client.stopping) {
        return;
      }
      if (errorMessage === "Negotiate Unknown" && !this._ignoredFirstNegotiationError) {
        this._ignoredFirstNegotiationError = true;
        console.log("I used to ignore this error", errorMessage);
        // return;
      }
      console.log("On Error, Attempting to disconnect and reconnect");
      console.log(errorMessage, e, errorData);
      try {
        client.end();
        if (errorData === 503) {
          this._cloudflareBypassReady = false;
        }
      } catch (e) {
        console.log("Caught error trying to end session", e, e.message);
      }
      setImmediate(() => {
        console.log("On error connect function");
        this._ensureCloudflareBypassValuesAreAvailable(() => {
          client.start();
        });
      });
      //   throw (errorMessage, e, errorData);
    };

    client.on("CoreHub", "updateExchangeState", message => {
      if (client.stopping) {
        return;
      }
      this._markets[message.MarketName]._processDeltaMessage(message);
    });

    client.start();

    this._clientPool.push(client);
    this._currentClient = client;
  }

  _ensureCloudflareBypassValuesAreAvailable(callback) {
    if (this._cloudflareBypassReady) {
      return callback();
    }
    this._cloudflareBypassCallbacksWaiting.push(callback);
    if (this._cloudflareBypassRequestInFlight) {
      return;
    }

    this._cloudflareBypassRequestInFlight = true;

    cloudscraper.get("https://bittrex.com/", (error, response, body) => {
      if (error) {
        console.log(error)
        console.log(response)
        console.log(body)
        throw new Error("Failed to circumvent cloudflare protection: " + JSON.stringify(error));
      }
      console.log('Bypassed cloudflare');
      console.log(response.request.headers);
      this._cloudflareUserAgent = response.request.headers["User-Agent"];
      this._cloudflareCookies = response.request.headers["cookie"];
      this._cloudflareBypassCallbacksWaiting.forEach(savedCallback => {
        savedCallback();
      });
    });
  }

  reset() {
    _.each(this._clientPool, client => {
      client.stopping = true;
      client.end();
    });

    this._setStartValues();
  }

  market(currencyPair, callback) {
    this._ensureCloudflareBypassValuesAreAvailable(() => {
      if (!(currencyPair in this._markets)) {
        this._subscribedCount++;
        this._markets[currencyPair] = new Market(currencyPair, this, this._replayHistory);
        this._addClient(client => {
          return this._subscribePair(currencyPair, client, callback);
        });
      } else {
        callback(null, this._markets[currencyPair]);
      }
    });
  }

  _subscribePair(currencyPair, client, callback) {
    if (client.stopping) {
      return;
    }
    if (this._subscribing || !client.wasConnected) {
      this._subscriptionQueue.push([currencyPair, client, callback]);
      return;
    } else {
      this._subscribing = true;
    }

    this._markets[currencyPair]._initialized = false; //make sure deltas get queued until the initial state is fetched
    client.call("CoreHub", "SubscribeToExchangeDeltas", currencyPair).done((err, result) => {
      if (err) throw err;
      if (!result) throw "Failed to subscribe to currency pair deltas";

      client.call("CoreHub", "QueryExchangeState", currencyPair).done((err, result) => {
        if (err) {
          delete this._markets[currencyPair];
          return callback(err, null);
        }
        if (!result) {
          delete this._markets[currencyPair];
          return callback("Failed to subscribe to currency pair exchange state", null);
        }
        this._markets[currencyPair]._initialize(result);
        client.currencyPairs.push(currencyPair);
        if (callback) {
          callback(null, this._markets[currencyPair]);
        }

        this._subscribing = false;

        if (this._subscriptionQueue.length > 0) {
          const pairToSubscribe = this._subscriptionQueue.shift();
          return this._subscribePair(pairToSubscribe[0], pairToSubscribe[1], pairToSubscribe[2]);
        }
      });
    });
  }
}

module.exports = MarketManager;
