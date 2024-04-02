import pino from "pino";
import pretty from "pino-pretty";

const streamPino = pretty({
  colorize: false
})

const logger = pino({
  /*prettyPrint: {
    ignore: "pid,hostname"
  }*/
  transport: {
    target: 'pino-pretty',
    options:{
      ignore: 'pid,hostname'
    }
  }
});

const upsertLogger = pino({
  base: null,
  timestamp: true,
  level: "info",
  prettyPrint: {
      colorize: false,
      timestamp: () => `,"time":"${new Date().toLocaleString('pt-BR')}"`,
      translateTime: 'SYS:standard',
      ignore: 'hostname,pid',
  },
  formatters: {
    level(label, number) {
      return { level: label };
    }
  },
  stream: streamPino
}, pino.destination({ dest: './logs/upsertLogger.log', sync: false }));

 
const whatsappLogger = pino({
  base: null,
  timestamp: () => `,"time":"${new Date().toLocaleString('pt-BR')}"`,
  level: "info",
  formatters: {
    level(label, number) {
      return { level: label };
    }
  },
  stream: streamPino
}, pino.destination({ dest: './logs/whatsappLogger.log', sync: false }));


const socketLogger = pino({
  base: null,
  timestamp: () => `,"time":"${new Date().toLocaleString('pt-BR')}"`,
  level: "info",
  formatters: {
    level(label, number) {
      return { level: label };
    }
  },
  stream: streamPino
}, pino.destination({ dest: './logs/socketLogger.log', sync: false }));

const connectionLogger = pino({
  base: null,
  timestamp: () => `,"time":"${new Date().toLocaleString('pt-BR')}"`,
  level: "info",
  formatters: {
    level(label, number) {
      return { level: label };
    }
  },
  stream: streamPino
}, pino.destination({ dest: './logs/connectionLogger.log', sync: false }));


export { logger, upsertLogger, whatsappLogger, socketLogger, connectionLogger };


 