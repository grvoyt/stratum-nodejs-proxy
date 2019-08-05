[![travis](https://img.shields.io/travis/TigerND/node-stratum-proxy.svg)](https://travis-ci.org/TigerND/node-stratum-proxy)
## Node Stratum Proxy Wattson
Стратум прокси с записью шар в базу данных

###Проверен на:
```
    https://pool.btc.com/
    https://btc.sigmapool.com/
```

## Install & Run

To run this proxy you need to:
* Install node.js from http://nodejs.org/
* Run the following commands:
```sh
  > npm install
  > npm install pm2 -g
  > cp config/app.sample.json config/app.json
  > nano config/app.json
  > pm2 start stratum-proxy.js
```

