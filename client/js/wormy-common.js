/**
 * Wormy multiplayer worm game.
 *
 * Author: Robert Flack (flackr@gmail.com)
 */

var bind = function(scope, fn /*, variadic args to curry */) {
  var args = Array.prototype.slice.call(arguments, 2);
  return function() {
    return fn.apply(scope, args.concat(
        Array.prototype.slice.call(arguments)));
  };
};

var clone = function(obj) {
  return JSON.parse(JSON.stringify(obj));
};

function LobbySocketAdapter(connection) {
  this.listeners_ = {};
  this.connection_ = connection;
  connection.addEventListener('message', this.onMessage.bind(this));
}

LobbySocketAdapter.prototype = {
  emit: function(type, data) {
    this.connection_.send({t: type, d: data});
  },

  on: function(type, callback) {
    if (!this.listeners_[type])
      this.listeners_[type] = [];
    this.listeners_[type].push(callback);
  },

  onMessage: function(m) {
    if (this.listeners_[m.t]) {
      for (var i = 0; i < this.listeners_[m.t].length; i++) {
        this.listeners_[m.t][i](m.d);
      }
    }
  },
};

function LobbyServerSocketAdapter(connection, index) {
  this.listeners_ = {};
  this.connection_ = connection;
  this.clientIndex_ = index;
  connection.addEventListener('message', this.onMessage.bind(this));
  connection.addEventListener('disconnection', this.onDisconnection.bind(this));
}

LobbyServerSocketAdapter.prototype = {
  emit: function(type, data) {
    this.connection_.send(this.clientIndex_, {t: type, d: data});
  },

  on: function(type, callback) {
    if (!this.listeners_[type])
      this.listeners_[type] = [];
    this.listeners_[type].push(callback);
  },

  onMessage: function(clientIndex, m) {
    if (clientIndex != this.clientIndex_)
      return;
    if (this.listeners_[m.t]) {
      for (var i = 0; i < this.listeners_[m.t].length; i++) {
        this.listeners_[m.t][i](m.d);
      }
    }
  },

  onDisconnection: function(clientIndex) {
    this.onMessage(clientIndex, {t: 'disconnect', m: {}});
  }
};

var wormy = function() {

  var adjust = function(factor, prop) {
    return (factor-1.0)*prop+1.0;
  };

  var gameInterval = 200;
  var newInterval;
  var tailInitial = 5;
  var tailInc = 8;

  var Game = function() {
    // Base game state.
    this.baseGameState_ = {
      l: undefined,
      food: [],
      p: [],
      f: 0,
    };

    // Current game state.
    this.state_ = undefined;
    this.started = false;

    // If an event is received in a previous frame the current game state is
    // marked stale and the game is replaced from the base game state forward.
    this.stateStale_ = false;

    this.frame = 0;
    this.moves_ = [];
    this.stepTimer_ = 0;
    this.lastStepTime_ = undefined;
  };

  Game.prototype = {
    buffer: 14,

    playAt: 4,

    targetGameInterval: gameInterval,

    moveVectors: [[-1, 0], [0, 1], [1, 0], [0, -1]],

    reset: function(state) {
      this.baseGameState_ = state.base;
      this.moves_ = state.moves;
      this.recomputeState();
      this.lastStepTime_ = undefined;
      this.lastSyncFrame = undefined;
      newInterval = undefined;
//      gameInterval = this.targetGameInterval;
    },

    stop: function() {
      clearInterval(this.stepTimer_);
      this.stepTimer_ = 0;
      this.started = false;
      this.lastStepTime_ = undefined;
      this.lastSyncFrame = undefined;
      newInterval = undefined;
    },

    start: function() {
      this.stepTimer_ = setInterval(bind(this, this.step), gameInterval);
      this.started = true;
    },

    addEvent: function(evt) {
      // If not started we use incoming packets to keep up with the frame.
      if (!this.started) {
        while (this.frame < evt.f - this.playAt)
          this.step();
      }
      var move_i = this.moves_.length - this.playAt - (this.frame - evt.f) - 1;
      if (move_i < 0 || move_i >= this.moves_.length) {
        return false;
      }
      this.moves_[move_i].push(evt.d);
      if (evt.f < this.frame)
        this.stateStale_ = true;
      return true;
    },

    getPartialFrame: function(frame, offset) {
      var pf = this.frame;
      if (this.lastStepTime_)
        pf += Math.min(1, ((new Date()).getTime() - this.lastStepTime_) / gameInterval);
      return pf;
    },

    sync: function(frame) {
      var syncInfo = [];
      var pf = this.getPartialFrame();
      if (this.lastSyncFrame) {
        var actualFrames = pf - this.lastSyncFrame[1];
        var expectedFrames = frame - this.lastSyncFrame[0];
        // Compute the ratio to be on time.
        var skew = adjust(actualFrames / expectedFrames, 0.7);
        // Add in skew to reach server frame at next sync.
        var offset = adjust(expectedFrames / ((frame + expectedFrames) - pf), 0.7);
        newInterval = gameInterval * skew * offset;
        // Allowing anywhere between (-30%, +30%)
        newInterval =
            Math.min(Math.max(newInterval, .65*this.targetGameInterval),
                     1.35 * this.targetGameInterval);
        syncInfo = [(Math.round(((pf - frame)/(1000/this.targetGameInterval))*100000)/100), // Offset in milliseconds.
                    (Math.round(((actualFrames - expectedFrames)/expectedFrames)*10000)/100), // Skew %fps of target.
                    (Math.round(((this.targetGameInterval - gameInterval)/this.targetGameInterval+1)*10000)/100), // Old game speed.
                    (Math.round(((this.targetGameInterval - newInterval)/this.targetGameInterval+1)*10000)/100)]; // New game speed.
//        console.log('Game is off by ' + syncInfo[0] + 'ms (rate off by '+syncInfo[1]+'%) adjusting game speed to '+syncInfo[3]+'%');
      }
      this.lastSyncFrame = [frame, pf];
      return syncInfo;
    },

    recomputeState: function() {
      this.state_ = clone(this.baseGameState_);
      for (var i = 0; i < this.moves_.length - this.playAt - 1; i++)
        this.process(this.state_, this.moves_[i]);
      this.stateStale_ = false;
    },

    step: function() {
      this.lastStepTime_ = (new Date()).getTime();
      if (newInterval) {
        gameInterval = newInterval;
        clearInterval(this.stepTimer_);
        this.stepTimer_ = setInterval(bind(this, this.step), gameInterval);
        newInterval = undefined;
      }
      // Add new frame for current moves.
      this.moves_.push([]);
      if (this.moves_.length > this.buffer) {
        var md = this.moves_.splice(0, this.moves_.length - this.buffer);
        for (var i = 0; i < md.length; i++)
          this.process(this.baseGameState_, md[i], true);
      }

      if (this.stateStale_) {
        this.recomputeState();
      } else if (this.moves_.length > this.playAt + 1) {
        this.process(this.state_, this.moves_[this.moves_.length - this.playAt - 2]);
      }
      this.frame++;
    },

    disconnected: function(playerNo) {
      // Don't do anything.
    },

    foodEaten: function(playerNo) {
      // Increase score maybe?
    },

    clearTail: function(g, playerNo) {
      if (g.p.length <= playerNo)
        return;
      for (var i = 0; i < g.p[playerNo].length; i++) {
        g.l[g.p[playerNo].t[i][0]][g.p[playerNo].t[i][1]] = 0;
      }
    },

    // Process move data |md| on game data |gd|.
    process: function(g, md, is_final) {
      for (var i = 0; i < md.length; i++) {
        if (md[i].t == 'm') { // Movement
          // Only change direction if alive.
          if (g.p[md[i].p].s == 0)
            g.p[md[i].p].t[0][2] = md[i].d;
        } else if (md[i].t == 'a') { // Add player.
          this.clearTail(g, md[i].p);
          g.p[md[i].p] = {
            t: [md[i].l],  // Tail
            l: tailInitial,  // Length
            s: 0,  // Start alive
            n: md[i].n, // Player name
          };
          g.l[g.p[md[i].p].t[0][0]][g.p[md[i].p].t[0][1]] = md[i].p + 3;
        } else if (md[i].t == 'd') { // Disconnect.
          if (g.p.length > md[i].p) {
            g.p[md[i].p].s = 2;
            if (!md[i].handled) {
              this.disconnected(md[i].p);
              md[i].handled = true;
            }
          }
        } else if (md[i].t == 'r') { // Revive.
          if (g.p.length > md[i].p &&
              g.p[md[i].p].t.length == 0 &&
              g.p[md[i].p].s == 1) {
            this.clearTail(g, md[i].p);
            g.p[md[i].p] = {
              t: [md[i].l],
              l: tailInitial,
              s: 0,
            };
            g.l[g.p[md[i].p].t[0][0]][g.p[md[i].p].t[0][1]] = md[i].p + 3;
          }
        } else if (md[i].t == 'f') {
          // FOOD!
          if (g.l[md[i].fy][md[i].fx] != 0) {
            if (is_final)
              this.foodEaten(-1);
          } else {
            g.l[md[i].fy][md[i].fx] = 2;
            g.food.push([md[i].fy, md[i].fx]);
          }
        }
      }
      var w = g.l[0].length;
      var h = g.l.length;
      var offset = g.f % g.p.length;
      for (var i = 0; i < g.p.length; i++) {
        var pi = (i + offset) % g.p.length;
        if (!g.p[pi].s) {
          var next = [(g.p[pi].t[0][0] + this.moveVectors[g.p[pi].t[0][2]][0] + h) % h,
                      (g.p[pi].t[0][1] + this.moveVectors[g.p[pi].t[0][2]][1] + w) % w,
                      g.p[pi].t[0][2]];
          if (g.l[next[0]][next[1]] == 2) {
            g.l[next[0]][next[1]] = 0;
            g.p[pi].l += tailInc;
            for (var j = 0; j < g.food.length; j++) {
              if (g.food[j][0] == next[0] && g.food[j][1] == next[1]) {
                g.food.splice(j, 1);
                j--;
              }
            }
            if (is_final) {
              this.foodEaten(pi);
            }
          }
          if (g.l[next[0]][next[1]]) {
            g.p[pi].s = 1;
            g.p[pi].l = 0;
          } else {
            g.p[pi].t.splice(0, 0, next);
            g.l[next[0]][next[1]] = pi + 3;
          }
        }
        if (g.p[pi].t.length && (g.p[pi].s ||
                                g.p[pi].t.length > g.p[pi].l)) {
          var tail = g.p[pi].t.pop();
          g.l[tail[0]][tail[1]] = 0;
        }
      }
      g.f++;
    },

    // End goal is 100 or three times as long as second longest worm.
    getEndGoal: function() {
      var l1 = 0;
      var l2 = 0;
      for (var i = 0; i < this.state_.p.length; i++) {
        if (this.state_.p[i].t) {
          var l = this.state_.p[i].t.length;
          if (l > l1) {
            l2 = l1;
            l1 = l;
          } else if (l > l2)
            l2 = l;
        }
      }
      return Math.max(100, 3 * l2);
    },
  };

  return {
    Game: Game,
  };
}();

if (typeof exports == 'object' && exports) {
  exports.Game = wormy.Game;
  exports.util = {
      bind: bind,
      clone: clone,
  };
}
