import Promise        from 'bluebird';
import express        from 'express';
import expressWinston from 'express-winston';
import helmet         from 'helmet';
import http           from 'http';
import path           from 'path';
import socket         from 'socket.io';

import API from './api';
import DB  from './db';
import Log from './log';
import Msg from './msg';
import SocketAPI from './socket-api';
import UrlShortener, { UrlNotFoundError } from './url-shortener';

function requiredEnv(name) {
  if (process.env[name] == null) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return process.env[name];
}

const log = new Log(requiredEnv('LOGPATH'));
const db  = new DB(log, requiredEnv('DBPATH'));
const msg = new Msg(db);
const urlShortener = new UrlShortener(log, db);
const api = new API({ log, db, msg, urlShortener });

const app = express();
app.use(helmet({
  hsts: {
    includeSubDomains: false,
  },
}));

const haveProxy = !process.env.NO_PROXY;

app.set('view engine', 'pug');
app.set('trust proxy', haveProxy);
app.locals.basedir = __dirname;

app.use(expressWinston.logger({ winstonInstance: log }));

app.use(async (req, res, next) => {
  const ip = req.ip;
  try {
    const id = await db.recordVisitor(ip);
    req.visitor_id = id;
    next();
  } catch (e) {
    log.error(e);
    res.sendStatus(500);
  }
});

if (!haveProxy) {
  const opts = {
    index: false,
    maxAge: '90d',
  };
  app.use(express.static(path.join(__dirname, '..', 'dist'), opts));
  app.use(express.static(path.join(__dirname, '..', 'public'), opts));
}

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/message-log', (req, res) => {
  res.render('message-log');
});

app.get('/u', (req, res) => {
  res.render('url-shortener');
});

app.get('/u/:word', async (req, res) => {
  const word = req.params.word;

  try {
    const url = await urlShortener.lookup(word);
    res.redirect(url);
  } catch (e) {
    if (e instanceof UrlNotFoundError) {
      res.status(404).render('url-not-found', { word });
    } else {
      log.error(e);
      res.status(500).end();
    }
  }
});

app.use('/api', api.router);

app.use(expressWinston.errorLogger({ winstonInstance: log }));

const port = parseInt(requiredEnv('PORT'), 10);

const httpServer = http.createServer(app);
httpServer.listen(port, () => {
  log.info('HTTP server started on port %d', port);
});

const io = socket(httpServer);

new SocketAPI({ api, io, msg });

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('shutting down');

  const serversClosed = Promise.fromCallback((cb) => {
    httpServer.close(cb);
  });

  try {
    urlShortener.close();
    await db.close();
    await serversClosed;
    log.info('good night');
  } catch (e) {
    log.error(e);
    throw e;
  }
}

process.on('message', async (msg) => {
  if (msg === 'shutdown') {
    try {
      await shutdown();
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  }
});

process.on('SIGINT', shutdown);
// nodemon
process.once('SIGUSR2', async () => {
  await shutdown();
  process.kill(process.pid, 'SIGUSR2');
});
