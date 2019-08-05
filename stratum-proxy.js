//setMaxListeners
require('events').EventEmitter.prototype._maxListeners = 0;

var path = require('path')

var config = require('konfig')({
    path: path.join(__dirname, 'config')
})

var morgan = require('morgan')

var log = null
if (config.app.debug) log = morgan('dev');


var util = require("util"),
    async = require("async"),
    http = require('http'),
    net = require('net'),
    url = require('url'),
    uuid = require('uuid'),
    sio = require('socket.io'),
    mysql = require('mysql');

/* mysql */
var connection = mysql.createPool(config.app.mysql);


/* Proxy
============================================================================= */

var proxies = {}
var clients = [{id:''}];
var nameMainAccount = config.app.account;
var subUser = {};
var ProxyObject = function(socket, proxy) {
    var self = this

    this.log = function(message,data) {
        var self = this;
        var nowDate = new Date();
        var prefix = '\n'+nowDate.toLocaleDateString()+' '+nowDate.toLocaleTimeString();
        prefix += '(' + Object.keys(proxies).length + ')[' + self.id + ']';

        if (self.client) {
            prefix += '[' + self.client.remoteAddress + ':' + self.client.remotePort + '<-' + self.client.localAddress + ':' + self.client.localPort + ']'
        } else {
            prefix += '[null]'
        }
        if (self.socket) {
            prefix += '[' + self.socket.localAddress + ':' + self.socket.localPort + '<-' + self.socket.remoteAddress + ':' + self.socket.remotePort + ']'
        } else {
            prefix += '[null]'
        }
        if(data) {
            console.log(prefix + '\n' + message, data);
        } else {
            console.log(prefix + '\n' + message);
        }
    }
    this.destroy = function() {
        var self = this
        var client = self.client
        var events = {
            names: ['error', 'end', 'data'],
            close: function(socket) {
                this.names.forEach(function(evt) {
                    socket.on(evt, function() {})
                })
                socket.end()
            }
        }
        if ((self.client) && (self.client.remoteAddress)) {
            self.log('[POOL] Closing connection')
            events.close(self.client)
        }
        self.client = null
        if ((self.socket) && (self.socket.remoteAddress)) {
            self.log('[MINER] Closing connection')
            events.close(self.socket)
        }
        self.socket = null
        delete proxies[self.id]
        self.log('[PROXY] Closed, ' + Object.keys(proxies).length + ' active proxies');
    }

    this.onServerError = function(err) {
        var self = this
        self.log('[MINER] Error: ' + err.message)
        self.destroy()
    }
    this.onServerEnd = function(data) {
        var self = this
        self.log('[MINER] Disconnected')
        self.socket = null
        self.destroy()
    }
    this.onServerData = function(data) {
        var self = this,
            dataTemp;
        if ((self.client) && (self.client.remoteAddress)) {
            if (self.debug) self.log('[MINER] data: ' + data);
            dataTemp = data.toString().split('\n');
            var dataSend = [];
            dataTemp.forEach(function(data,key) {
                if(data == '') return;
                if(data.indexOf('}') == -1 || data.indexOf('{') == -1) {
                    self.log('MINER bad data', data);
                    dataSend.push(data);
                    return;
                }
                try {
                    var jsonTemp = JSON.parse(data);
                } catch(e) {
                    self.log('Cant parse data from '+data);
                    dataSend.push(data);
                    return;
                }

                if(jsonTemp.method) {
                    switch (jsonTemp.method) {
                        case "mining.authorize":
                            self.setAsic();
                            dataSend.push(self.changeUser(jsonTemp, 'authorize'));
                            break;
                        case 'mining.submit':
                            dataSend.push(self.changeUser(jsonTemp, 'submit'));
                            break;
                        case 'mining.subscribe':

                            break;
                        case 'mining.configure':
                            console.log("TRY CONFIGURE \n\n");
                            break;
                    }
                }
            });
            data = dataSend.join('\n');
            if(self.debug) console.log('CLIENTS', clients);
            self.client.write(data+'\n','utf8', function(e) {
                self.log('{MINER} sended');
            });
        } else {
            self.log('[MINER] bufferData: ' + data)
            self.buffer += data
        }
    }

    this.changeUser = function(data,type) {
        var self = this;
        var defUser = data.params[0],
            loginUser = defUser.split('.')[0];

        var idInPool = 0,
            id = 0;
        for(key in clients) {
            if(clients[key].id == self.id) {
                id = key;
                clients[key].name = loginUser;
            }
        }

        var newLogin = '';
        if(id < 10) newLogin = '00'+id;
        if(id >= 10 && id < 100) newLogin = '0'+id;
        if(id >= 100) newLogin = id;

        switch(type) {
            case 'authorize':
                self.asic_name = data.params[0];
                data.params[0] = nameMainAccount+'.'+newLogin;
                if(self.debug) console.log('AUTH =>', data.params[0],'inSelf =>',self.asic_name);
                break;
            case 'submit':
                data.params[0] = nameMainAccount+'.'+newLogin;
                subUser[defUser] = data.id;
                self.last_share_id.push(data.id);
                if(self.debug) console.log('submit_id =>', self.last_share_id);
                break;
        }
        var newData =  JSON.stringify(data);
        return newData;
    }

    this.onPoolConnect = function(client) {
        var self = this
        self.log('[POOL] Connected')
        if (!self.client) {
            self.log('[POOL] Too late')
            client.end()
            return
        }
        if (self.buffer) {
            self.log('[POOL] poolconnect_buffer: ' + self.buffer);
            self.client.write(self.buffer,'utf8', function() {
                self.log('{POOL} send data to client')
            });
            self.buffer = '';
        }
    }
    this.onPoolError = function(client, err) {
        var self = this
        self.log('[POOL] Error: ' + err.message)
        self.destroy()
    }
    this.onPoolEnd = function(client) {
        var self = this
        self.log('[POOL] Disconnected')
        self.client = null
        self.destroy()
    }
    this.onPoolData = function(client, data) {
        var self = this,
            dataTemp;
        if (self.socket && self.socket.remoteAddress) {
            if (self.debug) self.log('[POOL] send: ' + data);
            messages = data.toString().split('\n');
            messages.forEach(function(dataJson,key) {
                if (dataJson == '') return;
                if (dataJson.indexOf('}') == -1 || dataJson.indexOf('{') == -1) {
                    self.log('[POOL] bad data', dataTemp);
                    return;
                }
                var jsonTemp = JSON.parse(dataJson);

                // проверяем другие методы
                switch (jsonTemp.method) {
                    case 'mining.set_difficulty':
                        self.setDifficulty(jsonTemp.params[0], self.id);
                        break;
                }

                if(self.last_share_id.indexOf(jsonTemp.id) > 0) {
                    if(self.debug) {
                        console.log('data: ',jsonTemp);
                        console.log('shareId: ',self.last_share_id);
                    }
                    self.sendShare(jsonTemp);
                    return;
                }



            });
            self.socket.write(data);
        } else {
            self.log('[POOL] bufferData: ' + data)
            self.buffer += data
        }
    }

    this.sendShare = function(data) {
        var self = this;
        //error => { code: 21, message: 'job not found', data: null }
        //success => result:true
        if (self.debug) console.log('share ==> ', self.id,self.last_share_id);
        var dbData = [
            self.socket.remoteAddress,
            self.asic_name,
            data.result ? 'Y' : 'N',
            data.error ? 'Y' : 'N',
            self.difficulty,
            !data.error ? '' : JSON.stringify(data.error)
        ];
        connection.query(
            'INSERT INTO `shares` SET time = NOW(), rem_host = ?, username = ?, our_result = ?, upstream_result = ?, difficulty = ?, reason = ?',
            dbData,
            function(err, result) {
                if (err) {
                    if (self.debug) console.log('Insert error when adding share: ' + JSON.stringify(err));
                }
                else {
                    if (self.debug) console.log('Share inserted to=> '+self.asic_name);
                    delete self.last_share_id[self.last_share_id.indexOf(data.id)];
                }
            }
        );

    }

    this.checkShare = function(data) {
        return (self.last_share_id == data.id) ? true : false;
    }

    this.setAsic = function() {
        var result = false,
            self = this,
            id = self.id;
        var ids = clients.map(function(el) {
            return el.id;
        });

        if( ids.indexOf(id) == -1 ) {
            clients.push({id: id});
            if(self.debug) console.log('setAsic =>', id, self.id);
            result = true;
        }
        return result;
    }

    this.setDifficulty = function (diff,id) {

        var result = false,
            nameTemp = 'none',
            self = this;
        self.difficulty = diff;
        for(cli in clients) {
            if( clients[cli].id == id ) {
                clients[cli].difficulty = diff;
                if(clients[cli].name) nameTemp = clients[cli].name;
                result = true;
            }
        }
        if(self.debug) console.log('setDiff =>>',self.id,diff);
        return result;
    }

    self.id = uuid.v4()
    self.socket = socket
    self.proxy = proxy
    self.buffer = ''
    self.debug = config.app.debug;
    self.last_share_id = [];
    self.asic_name = '';
    self.client = {};

    proxies[self.id] = this

    self.socket.on('error', function(err) {
        self.onServerError(err)
    })
    self.socket.on('end', function() {
        self.onServerEnd()
    })
    self.socket.on('data', function(dataBuffer) {
        self.onServerData(dataBuffer);
    })

    self.log('[POOL] Connecting to ' + JSON.stringify(self.proxy.connect))
    var client = net.connect(self.proxy.connect, function() {
        self.client = client
        self.onPoolConnect(client)
    })
    client.on('error', function(err) {
        self.onPoolError(client, err)
    })
    client.on('end', function() {
        self.onPoolEnd(client)
    })
    client.on('data', function(dataBuffer) {
        self.onPoolData(client, dataBuffer);
    })
}

/* Common API functions
============================================================================= */

function makeSocketInfo(socket) {
    var result = null
    if (socket) {
        result = {
            local: {
                host: socket.localAddress,
                port: socket.localPort
            },
            remote: {
                host: socket.remoteAddress,
                port: socket.remotePort
            }
        }
    }
    return result
}

function makeProxesInfo() {
    var result = []
    for (var k in proxies) {
        if (proxies.hasOwnProperty(k)) {
            var proxy = proxies[k]
            var item = {
                id: proxy.id,
                type: "simple",
                miner: makeSocketInfo(proxy.socket),
                pool: makeSocketInfo(proxy.client)
            }
            result.push(item)
        }
    }
    return result
}

/* Starting proxies
============================================================================= */

async.eachSeries(config.app.proxy, function(proxy, callback) {
    var server = net.createServer(function(socket) {
        var po = new ProxyObject(socket, proxy);
        server.setMaxListeners(1000);
        server.on('error', function (err) {
            callback(err)
        })
    })
    server.listen(proxy.listen.port, function() {
        if (proxy.comment) {
            var comment = '(' + proxy.comment + ')'
        }
        console.log('Proxy server started at port ' + proxy.listen.port + ' for ' + proxy.connect.host + ':' + proxy.connect.port, comment || '')
        callback()
    })
}, function(err){
    if (err) {
        console.log('Failed to start a proxy:', err);
    } else {
        console.log('All proxies have been processed successfully');
    }
});