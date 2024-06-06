import makeWASocket, {
  WASocket,
  AuthenticationState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import NodeCache from "node-cache";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import BaileysSessions from "../models/BaileysSessions";
import { useMultiFileAuthState } from "../helpers/useMultiFileAuthState";

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache();

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

type Session = WASocket & {
  id?: number;
  store?: Store;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWbot = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, isMultidevice } = whatsappUpdate;
        const { version, isLatest } = await fetchLatestBaileysVersion();

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`isMultidevice: ${isMultidevice}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;
        const store = makeInMemoryStore({
          logger: loggerBaileys
        });
        store?.readFromFile(`./baileys_store_multi_${whatsapp.id}.json`)
        // save every 10s
        setInterval(() => {
          store?.writeToFile(`./baileys_store_multi_${whatsapp.id}.json`)
        }, 10_000)

        const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_info_${whatsapp.id}`)

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          auth: state as AuthenticationState,
          version,
          msgRetryCounterCache,
          getMessage: async key => {
            if (store) {
              const msg = await store.loadMessage(key.remoteJid!, key.id!);
              return msg?.message || undefined;
            }
          }
        });

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `Socket  ${name} Connection Update ${connection || ""} ${lastDisconnect || ""
              }`
            );

            const disconect = (lastDisconnect?.error as Boom)?.output
              ?.statusCode;

            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            // if (connection === "close") {
            //   if (reason === DisconnectReason.badSession) {
            //     logger.error("Bad Session, Please Delete /auth and Scan Again");
            //     process.exit();
            //   } else if (reason === DisconnectReason.connectionClosed) {
            //     logger.warn("Connection closed, reconnecting....");
            //     // await startSocketServer();
            //   } else if (reason === DisconnectReason.connectionLost) {
            //     logger.warn("Connection Lost from Server, reconnecting...");
            //     // await startSocketServer();
            //   } else if (reason === DisconnectReason.connectionReplaced) {
            //     logger.error(
            //       "Connection Replaced, Another New Session Opened, Please Close Current Session First"
            //     );
            //     process.exit();
            //   } else if (reason === DisconnectReason.loggedOut) {
            //     logger.error(
            //       "Device Logged Out, Please Delete /auth and Scan Again."
            //     );
            //     process.exit();
            //   } else if (reason === DisconnectReason.restartRequired) {
            //     logger.info("Restart Required, Restarting...");
            //     // await startSocketServer();
            //   } else if (reason === DisconnectReason.timedOut) {
            //     logger.warn("Connection TimedOut, Reconnecting...");
            //     // await startSocketServer();
            //   } else {
            //     logger.warn(
            //       `Unknown DisconnectReason: ${reason}: ${connection}`
            //     );
            //     // await startSocketServer();
            //   }
            // }

            if (connection === "close") {
              if (disconect === 403) {
                await whatsapp.update({
                  status: "PENDING",
                  session: "",
                  number: ""
                });
                await DeleteBaileysService(whatsapp.id);

                await BaileysSessions.destroy({
                  where: {
                    whatsappId: whatsapp.id
                  }
                });

                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
              }

              if (disconect !== DisconnectReason.loggedOut) {
                removeWbot(id, false);
                setTimeout(() => StartWhatsAppSession(whatsapp), 2000);
              }

              if (disconect === DisconnectReason.loggedOut) {
                await whatsapp.update({
                  status: "PENDING",
                  session: "",
                  number: ""
                });
                await DeleteBaileysService(whatsapp.id);

                await BaileysSessions.destroy({
                  where: {
                    whatsappId: whatsapp.id
                  }
                });

                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
                setTimeout(() => StartWhatsAppSession(whatsapp), 2000);
              }
            }

            if (connection === "open") {
              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              io.emit("whatsappSession", {
                action: "update",
                session: whatsapp
              });

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsappUpdate.id);
                await BaileysSessions.destroy({
                  where: {
                    whatsappId: whatsapp.id
                  }
                });
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsappUpdate
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
              }
            }
          }
        );

        wsocket.ev.on("creds.update", saveCreds);

        wsocket.store = store;
        store.bind(wsocket.ev);
      })();
    } catch (error) {
      console.log(error);
      reject(error);
    }
  });
};
