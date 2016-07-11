/*global require, Buffer, exports, GLOBAL, process*/
'use strict';
var fs = require('fs');
var toml = require('toml');
var log = require('./logger').logger.getLogger('Main');

var config;
try {
  config = toml.parse(fs.readFileSync('./portal.toml'));
} catch (e) {
  log.error('Parsing config error on line ' + e.line + ', column ' + e.column + ': ' + e.message);
  process.exit(1);
}

// Configuration default values
config.portal = config.portal || {};
config.portal.ip_address = config.portal.ip_address || '';
config.portal.hostname = config.portal.hostname|| '';
config.portal.port = config.portal.port || 8080;
config.portal.ssl = config.portal.ssl || false;
config.portal.roles = config.portal.roles || {'presenter':{'publish': true, 'subscribe':true, 'record':true}, 'viewer':{'subscribe':true}, 'viewerWithData':{'subscribe':true, 'publish':{'audio':false,'video':false,'screen':false,'data':true}}};

config.cluster = config.cluster || {};
config.cluster.name = config.cluster.name || 'woogeen-cluster';
config.cluster.join_retry = config.cluster.join_retry || 5;
config.cluster.join_interval = config.cluster.join_interval || 3000;
config.cluster.recover_interval = config.cluster.recover_interval || 1000;
config.cluster.keep_alive_interval = config.cluster.keep_alive_interval || 1000;
config.cluster.report_load_interval = config.cluster.report_load_interval || 1000;
config.cluster.max_load = config.cluster.max_laod || 0.85;
config.cluster.network_max_scale = config.cluster.network_max_scale || 1000;

config.rabbit = config.rabbit || {};
config.rabbit.host = config.rabbit.host || 'localhost';
config.rabbit.port = config.rabbit.port || 5672;


var amqper = require('./amqper');
var server;
var worker;

var ip_address;
(function getPublicIP() {
  var BINDED_INTERFACE_NAME = config.portal.networkInterface;
  var interfaces = require('os').networkInterfaces(),
    addresses = [],
    k,
    k2,
    address;

  for (k in interfaces) {
    if (interfaces.hasOwnProperty(k)) {
      for (k2 in interfaces[k]) {
        if (interfaces[k].hasOwnProperty(k2)) {
          address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
            if (k === BINDED_INTERFACE_NAME || !BINDED_INTERFACE_NAME) {
              addresses.push(address.address);
            }
          }
        }
      }
    }
  }

  if (config.portal.ip_address === '' || config.portal.ip_address === undefined){
    ip_address = addresses[0];
  } else {
    ip_address = config.portal.ip_address;
  }
})();

var getTokenKey = function(id, on_key) {
  amqper.callRpc('nuve', 'getKey', id, {
    callback: function (key) {
      if (key === 'error' || key === 'timeout') {
        log.info('Failed to get token key.');
        worker && worker.quit();
        return process.exit();
      }
      on_key(key);
    }
  });
};

var joinCluster = function (on_ok) {
  var joinOK = on_ok;

  var joinFailed = function (reason) {
    log.error('portal join cluster failed. reason:', reason);
    worker && worker.quit();
    process.exit();
  };

  var loss = function () {
    log.info('portal lost.');
  };

  var recovery = function () {
    log.info('portal recovered.');
  };

  var spec = {amqper: amqper,
              purpose: 'portal',
              clusterName: config.cluster.name,
              joinRery: config.cluster.join_retry,
              joinPeriod: config.cluster.join_interval,
              recoveryPeriod: config.cluster.recover_interval,
              keepAlivePeriod: config.cluster.keep_alive_interval,
              info: {ip: ip_address,
                     hostname: config.portal.hostname,
                     port: config.portal.port,
                     ssl: config.portal.ssl,
                     state: 2,
                     max_load: config.cluster.max_load
                    },
              onJoinOK: joinOK,
              onJoinFailed: joinFailed,
              onLoss: loss,
              onRecovery: recovery,
              loadCollection: {period: config.cluster.report_load_interval,
                               item: {name: 'cpu'}}
             };

  worker = require('./clusterWorker')(spec);
};

var startServer = function(id, tokenKey) {
  var rpcChannel = require('./rpcChannel')(amqper);
  var rpcClient = require('./rpcClient')(rpcChannel);

  var portal = require('./portal')({tokenKey: tokenKey,
                                    tokenServer: 'nuve',
                                    clusterName: config.cluster.name,
                                    selfRpcId: id,
                                    permissionMap: config.portal.roles},
                                    rpcClient);
  server = require('./socketIOServer')({port: config.portal.port, ssl: config.portal.ssl, keystorePath: config.portal.keystorePath}, portal);
  return server.start()
    .then(function() {
      log.info('start socket.io server ok.');
    })
    .catch(function(err) {
      log.error('Failed to start socket.io server, reason:', err.message);
      throw err;
    });
};

var stopServer = function() {
  server && server.stop();
  server = undefined;
  worker && worker.quit();
  worker = undefined;
};

var rpcPublic = {
  drop: function(participantId, fromRoom, callback) {
    server &&  server.drop(participantId, fromRoom);
    callback('callback', 'ok');
  },
  notify: function(participantId, event, data, callback) {
    server && server.notify(participantId, event, data);
    callback('callback', 'ok');
  }
};

amqper.connect(config.rabbit, function () {
  try {
    amqper.setPublicRPC(rpcPublic);
    joinCluster(function(id) {
      log.info('portal join cluster ok, with rpcID:', id);
      amqper.bind(id, function() {
        log.info('bind amqp client ok.');
        getTokenKey(id, function(tokenKey) {
          startServer(id, tokenKey);
        });
      });
    });
  } catch (error) {
    log.error('Error in Erizo portal:', error);
    stopServer();
    process.exit();
  }
});

['SIGINT', 'SIGTERM'].map(function (sig) {
  process.on(sig, function () {
    log.warn('Exiting on', sig);
    stopServer();
    process.exit();
  });
});
