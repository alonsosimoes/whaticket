import pino from "pino";

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

export { logger };
