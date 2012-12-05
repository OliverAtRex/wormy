/**
 * An API for hosting a game on the lobby server.
 */

lobby.serverCapable = function() {
  return chrome.socket && chrome.socket.listen;
};

lobby.Host = function() {

  var constructWebsocketResponseKey = function(clientKey) {
    var toArray = function(str) {
      var a = [];
      for (var i = 0; i < str.length; i++) {
        a.push(str.charCodeAt(i));
      }
      return a;
    }
    var toString = function(a) {
      var str = '';
      for (var i = 0; i < a.length; i++) {
        str += String.fromCharCode(a[i]);
      }
      return str;
    }
    // Magic string used for websocket connection key hashing:
    // http://en.wikipedia.org/wiki/WebSocket
    var magicStr = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    // clientKey is base64 encoded key.
    clientKey += magicStr;
    var sha1 = new lobby.Sha1();
    sha1.reset();
    sha1.update(toArray(clientKey));
    return btoa(toString(sha1.digest()));
  };

  var ArrayBufferToString = function(buffer) {
    return String.fromCharCode.apply(null, new Uint8Array(buffer));
  };

  var StringToArrayBuffer = function(string) {
    var buffer = new ArrayBuffer(string.length);
    var bufferView = new Uint8Array(buffer);
    for (var i = 0; i < string.length; i++) {
      bufferView[i] = string.charCodeAt(i);
    }
    return buffer;
  };

  var WebsocketFrameString = function(str) {
    var length = str.length;
    if (str.length > 65535)
      length += 10;
    else if (str.length > 125)
      length += 4;
    else
      length += 2;
    var lengthBytes = 0;
    var buffer = new ArrayBuffer(length);
    var bv = new Uint8Array(buffer);
    bv[0] = 128 | 1; // Fin and type text.
    bv[1] = str.length > 65535 ? 127 :
            (str.length > 125 ? 126 : str.length);
    if (str.length > 65535)
      lengthBytes = 8;
    else if (str.length > 125)
      lengthBytes = 2;
    var len = str.length;
    for (var i = lengthBytes - 1; i >= 0; i--) {
      bv[2 + i] = len & 255;
      len = len >> 8;
    }
    var dataStart = lengthBytes + 2;
    for (var i = 0; i < str.length; i++) {
      bv[dataStart + i] = str.charCodeAt(i);
    }
    return buffer;
  }

  // port {@number} port number to host a game.
  var Host = function(lobbyUrl, port) {
    lobby.util.EventSource.apply(this);

    this.lobbyUrl_ = lobbyUrl;
    this.clients = [];
    this.gameInfo = {
      'gameId': 'default',
      'name': 'Default',
      'description': 'This is the default game description',
      'status': 'awaiting_players',
      'accepting': true,
      'observable': true,
      'password': false,
      'players': [],
      'port': port,
    };
    if (lobby.serverCapable())
      this.listen(this.gameInfo.port);
  }

  Host.prototype = lobby.util.extend(lobby.util.EventSource.prototype, {

    updateInfo: function(info) {
      if (info) {
        for (var i in info) {
          this.gameInfo[i] = info[i];
        }
      }
      // TODO(flackr): Throttle game info updates to the lobby.
      if (this.ws_ && this.ws_.readyState == 1)
        this.ws_.send(JSON.stringify({type: 'update', details: this.gameInfo}));
    },

    listen: function(port) {
      var self = this;
      chrome.socket.create('tcp', {}, function(socketInfo) {
        self.socketId_ = socketInfo.socketId;
        chrome.socket.listen(self.socketId_, '0.0.0.0', port, function(result) {
          if (result < 0) {
            console.log('Failed to listen on port '+port);
            return;
          }
          self.acceptConnection(port);
          self.registerServer();
          self.dispatchEvent('ready', 'ws://localhost:'+port+'/');
        });
      });
    },

    registerServer: function() {
      var self = this;
      this.ws_ = new WebSocket(this.lobbyUrl_, ['game-protocol']);
      this.ws_.onopen = function(evt) {
        self.ws_.send(JSON.stringify({type: 'register', details: self.gameInfo}));
      };
      this.ws_.onclose = this.connectionLost.bind(this);
      this.ws_.onmessage = this.lobbyMessageReceived.bind(this);
      this.ws_.onerror = this.onError.bind(this);
    },

    acceptConnection: function(port) {
      var self = this;
      chrome.socket.accept(self.socketId_, function(acceptInfo) {
        var clientIndex = self.clients.length;
        self.clients[clientIndex] = {socketId: acceptInfo.socketId, state: 'connecting', data: ''};
        self.listenOnSocket(clientIndex);
        self.acceptConnection(port);
      });
    },

    // Receive messages from the client identified by |clientIndex|.
    listenOnSocket: function(clientIndex) {
      var self = this;
      chrome.socket.read(this.clients[clientIndex].socketId, function(readInfo) {
        if (readInfo.resultCode <= 0) {
          self.closeClientConnection(clientIndex);
          return;
        }
        if (!readInfo.data.byteLength)
          return;
        if (self.clients[clientIndex].state == 'connecting') {
          self.clients[clientIndex].data += ArrayBufferToString(readInfo.data).replace(/\r\n/g,'\n');
          var messages = self.clients[clientIndex].data.split('\n\n');
          for (var i = 0; i < messages.length - 1; i++)
            if (!self.handleClientMessage(clientIndex, messages[i]))
              return;
          self.clients[clientIndex].data = messages[messages.length - 1];
        } else {
          var data = self.clients[clientIndex].rawData;

          var a = new Uint8Array(readInfo.data);
          for (var i = 0; i < a.length; i++)
            data.push(a[i]);

          while (data.length) {
            var length_code = -1;
            var data_start = 6;
            var mask;
            var fin = (data[0] & 128) >> 7;
            var op = data[0] & 15;

            if (data.length > 1)
              length_code = data[1] & 127;
            if (length_code > 125) {
              if ((length_code == 126 && data.length > 7) ||
                  (length_code == 127 && data.length > 14)) {
                if (length_code == 126) {
                  length_code = data[2] * 256 + data[3];
                  mask = data.slice(4, 8);
                  data_start = 8;
                } else if (length_code == 127) {
                  length_code = 0;
                  for (var i = 0; i < 8; i++) {
                    length_code = length_code * 256 + data[2 + i];
                  }
                  mask = data.slice(10, 14);
                  data_start = 14;
                }
              } else {
                length_code = -1; // Insufficient data to compute length
              }
            } else {
              if (data.length > 5)
                mask = data.slice(2, 6);
            }

            if (length_code > -1 && data.length >= data_start + length_code) {
              var decoded = data.slice(data_start, data_start + length_code).map(function(byte, index) {
                return byte ^ mask[index % 4];
              });
              if (fin && op > 0) {
                // Unfragmented message.
                self.handleClientMessage(clientIndex, ArrayBufferToString(decoded));
              } else {
                // Fragmented message.
                self.clients[clientIndex].data += ArrayBufferToString(decoded);
                if (fin) {
                  self.handleClientMessage(clientIndex, self.clients[clientIndex].data);
                  self.clients[clientIndex].data = '';
                }
              }
              data = self.clients[clientIndex].rawData = data.slice(data_start + length_code);
            } else {
              break; // Insufficient data to complete frame.
            }
          }
        }
        self.listenOnSocket(clientIndex);
      });
    },

    handleClientMessage: function(clientIndex, message) {
      if (this.clients[clientIndex].state == 'connecting') {
        message = message.split('\n');
        var messageDetails = {};
        for (var i = 0; i < message.length; i++) {
          var details = message[i].split(':');
          if (details.length == 2)
            messageDetails[details[0].trim()] = details[1].trim();
        }
        if (messageDetails['Upgrade'] != 'websocket' ||
            !messageDetails['Sec-WebSocket-Key'] ||
            !messageDetails['Sec-WebSocket-Protocol']) {
          this.closeClientConnection(clientIndex);
          return false;
        }
        var responseKey = constructWebsocketResponseKey(
            messageDetails['Sec-WebSocket-Key']);
        var response =
            'HTTP/1.1 101 Switching Protocols\n' +
            'Upgrade: websocket\n' +
            'Connection: Upgrade\n' +
            'Sec-WebSocket-Accept: ' + responseKey + '\n' +
            'Sec-WebSocket-Protocol: ' + messageDetails['Sec-WebSocket-Protocol'] + '\n' +
            '\n';
        response = StringToArrayBuffer(response.replace(/\n/g, '\r\n'));
        var self = this;
        chrome.socket.write(this.clients[clientIndex].socketId, response, function(writeInfo) {
          if (writeInfo.resultCode < 0 || writeInfo.bytesWritten != response.byteLength) {
            self.closeClientConnection(self.clients[clientIndex].socketId);
            return;
          }
          self.clients[clientIndex].state = 'connected';
          self.clients[clientIndex].rawData = [];
          self.clients[clientIndex].data = '';
          self.dispatchEvent('connection', clientIndex);
        });
      } else {
        var json;
        try {
          json = JSON.parse(message);
        } catch (e) {
          this.closeClientConnection(clientIndex);
          return false;
        }
        this.dispatchEvent('message', clientIndex, json);
      }
      return true;
    },

    closeClientConnection: function(clientIndex) {
      // This may be called more than once. Once intending to close the
      // connection and a second time as a result of failing to listen for data
      // on the now closed connection.
      // TODO(flackr): Safely only call this once.
      if (this.clients[clientIndex]) {
        this.dispatchEvent('disconnection', clientIndex);
        chrome.socket.disconnect(this.clients[clientIndex].socketId);
        chrome.socket.destroy(this.clients[clientIndex].socketId);
        delete this.clients[clientIndex];
      }
    },

    // Send |message| to the client identified by |clientIndex|.
    send: function(clientIndex, message) {
      var self = this;
      var data = WebsocketFrameString(JSON.stringify(message));
      chrome.socket.write(this.clients[clientIndex].socketId, data, function(writeInfo) {
        if (writeInfo.resultCode < 0 ||
            writeInfo.bytesWritten !== data.byteLength) {
          self.closeClientConnection(self.clients[clientIndex].socketId);
        }
      });
    },

    connectionLost: function(evt) {
      console.log('Connection to lobby lost');
    },

    lobbyMessageReceived: function(evt) {
      try {
        var json = JSON.parse(evt.data);
        if (json.type == 'ping') {
          this.ws_.send(JSON.stringify({type: 'pong'}));
        }
      } catch(e) {
        this.ws_.close();
      }
    },

    onError: function(evt) {
      console.log('Error: ' + evt.data);
    },
  });

  return Host;
}();
