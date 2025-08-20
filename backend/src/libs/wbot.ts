import makeWASocket, {
  WASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessageKey,
  WAMessageContent,
  proto,
  CacheStore,
  isJidBroadcast,
  jidNormalizedUser
} from "@whiskeysockets/baileys";
import { Mutex } from "async-mutex";

import { Boom } from "@hapi/boom";
import NodeCache from "node-cache";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import authState from "../helpers/authState";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import Message from "../models/Message";
import waVersion from "../waversion.json";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";
import { Op } from "sequelize";
import { DecoupledDriverServices } from "../services/DecoupledDriverServices/DecoupledDriverServices";
import ShowTicketService from "../services/TicketServices/ShowTicketService";
import GetTicketWbot from "../helpers/GetTicketWbot";
import { getJidOf } from "../services/WbotServices/getJidOf";

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache();

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

type Session = WASocket & {
  id?: number;
  myJid?: string;
  myLid?: string;
  cacheMessage?: (msg: proto.IWebMessageInfo) => void;
  isRefreshing?: boolean;
  // store?: Store;
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
        // sessions[sessionIndex].ws.close();
      }

      sessions[sessionIndex].ev.removeAllListeners("connection.update");
      sessions[sessionIndex].ev.removeAllListeners("creds.update");
      sessions[sessionIndex].ev.removeAllListeners("presence.update");
      sessions[sessionIndex].ev.removeAllListeners("groups.upsert");
      sessions[sessionIndex].ev.removeAllListeners("groups.update");
      sessions[sessionIndex].ev.removeAllListeners("group-participants.update");
      sessions[sessionIndex].ev.removeAllListeners("contacts.upsert");
      sessions[sessionIndex].ev.removeAllListeners("contacts.update");
      sessions[sessionIndex].end(null);

      sessions[sessionIndex].ws.removeAllListeners();
      await sessions[sessionIndex].ws.close();
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

function getGreaterVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const numA = a[i] || 0;
    const numB = b[i] || 0;

    if (numA > numB) {
      return a;
    }
    if (numA < numB) {
      return b;
    }
  }

  return a;
}

const waVersionCache = new NodeCache({
  stdTTL: 60 * 60 * 24, // 24 hours
  checkperiod: 60 * 30, // 30 minutes
  useClones: false
});

const waVersionMutex = new Mutex();

const getProjectWAVersion = async () => {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/ticketz-oss/ticketz/refs/heads/main/backend/src/waversion.json"
    );
    const version = await res.json();
    return version;
  } catch (error) {
    logger.warn("Failed to get current WA Version from project repository");
  }
  return waVersion;
};

export const initWbot = async (
  whatsapp: Whatsapp,
  isRefresh = false
): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, isMultidevice } = whatsappUpdate;

        const autoVersion = await waVersionMutex.runExclusive(async () => {
          let wv = waVersionCache.get("waVersion");

          if (!wv) {
            wv = await getProjectWAVersion();

            if (!wv) {
              // anything will be greater
              return [2, 2300, 0];
            }

            waVersionCache.set("waVersion", wv);
          }

          return wv;
        });

        const version = getGreaterVersion(autoVersion, waVersion);

        logger.info(`using WA v${version.join(".")}`);
        logger.info(`isMultidevice: ${isMultidevice}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;
        const store = new NodeCache({
          stdTTL: 120,
          checkperiod: 30,
          useClones: false
        });

        async function getMessage(
          key: WAMessageKey
        ): Promise<WAMessageContent> {
          if (!key.id) return null;

          const message = store.get(key.id);

          if (message) {
            logger.debug({ message }, "cacheMessage: recovered from cache");
            return message;
          }

          logger.debug(
            { key },
            "cacheMessage: not found in cache - fallback to database"
          );

          let msg: Message;

          msg = await Message.findOne({
            where: { id: key.id, fromMe: true }
          });

          if (!msg) {
            logger.debug({ key }, "cacheMessage: not found in database");
            return undefined;
          }

          try {
            const data = JSON.parse(msg.dataJson);
            logger.debug(
              { key, data },
              "cacheMessage: recovered from database"
            );
            store.set(key.id, data.message);
            return data.message || undefined;
          } catch (error) {
            logger.error(
              { key },
              `cacheMessage: error parsing message from database - ${error.message}`
            );
          }

          return undefined;
        }
        // const store = makeInMemoryStore({
        //   logger: loggerBaileys
        // });

        const { state, saveState } = await authState(whatsapp);

        const msgRetryCounterCache = new NodeCache();
        const userDevicesCache: CacheStore = new NodeCache();
        const internalGroupCache = new NodeCache({
          stdTTL: 5 * 60,
          useClones: false
        });
        const groupCache: CacheStore = {
          get: <T>(key: string): T => {
            logger.debug(`groupCache.get ${key}`);
            const value = internalGroupCache.get(key);
            if (!value) {
              logger.debug(`groupCache.get ${key} not found`);
              wsocket.groupMetadata(key).then(async metadata => {
                logger.debug({ key, metadata }, `groupCache.get ${key} set`);
                internalGroupCache.set(key, metadata);
              });
            }
            return value as T;
          },
          set: async (key: string, value: any) => {
            logger.debug({ key, value }, `groupCache.set ${key}`);
            return internalGroupCache.set(key, value);
          },
          del: async (key: string) => {
            logger.debug(`groupCache.del ${key}`);
            return internalGroupCache.del(key);
          },
          flushAll: async () => {
            logger.debug("groupCache.flushAll");
            return internalGroupCache.flushAll();
          }
        };

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          emitOwnEvents: true,
          markOnlineOnConnect: false,
          browser: ["Multiwhats", "Desktop", "1.0.0"],
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys)
          },
          version,
          defaultQueryTimeoutMs: 60000,
          msgRetryCounterCache,
          generateHighQualityLinkPreview: true,
          userDevicesCache,
          getMessage,
          cachedGroupMetadata: async jid => groupCache.get(jid),
          shouldIgnoreJid: jid =>
            isJidBroadcast(jid) || jid?.endsWith("@newsletter"),
          transactionOpts: { maxCommitRetries: 1, delayBetweenTriesMs: 10 }
          // getMessage: async key => {
          //   if (store) {
          //     const msg = await store.loadMessage(key.remoteJid!, key.id!);
          //     return msg?.message || undefined;
          //   }
          // }
        });

        wsocket.isRefreshing = isRefresh;

        wsocket.cacheMessage = (msg: proto.IWebMessageInfo): void => {
          if (!msg.key.fromMe) return;

          logger.debug({ message: msg.message }, "cacheMessage: saved");

          store.set(msg.key.id, msg.message);
        };

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `Socket  ${name} Connection Update ${connection || ""} ${
                lastDisconnect || ""
              }`
            );

            const disconect = (lastDisconnect?.error as Boom)?.output
              ?.statusCode;

            if (connection === "close") {
              if ((lastDisconnect?.error as Boom)?.output?.statusCode === 403) {
                await removeWbot(id);
                await whatsapp.update({
                  status: "DISCONNECTED",
                  session: "",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsapp.id);
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
              }

              if (
                (lastDisconnect?.error as Boom)?.output?.statusCode !==
                DisconnectReason.loggedOut
              ) {
                await whatsapp.update({ status: "PENDING" });
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false).then(() => {
                  logger.info(`Reconnecting ${name} in 2 seconds`);
                  setTimeout(async () => {
                    await whatsapp.reload();
                    await StartWhatsAppSession(
                      whatsapp
                    );
                  }, 2000);
                });
              } else {
                 await removeWbot(id);
                await whatsapp.update({
                  status: "DISCONNECTED",
                  session: "",
                  qrcode: ""
                });
                 await DeleteBaileysService(whatsapp.id);
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsapp
                });
              }
            }

            if (connection === "open") {
              wsocket.myLid = jidNormalizedUser(wsocket.user?.lid);
              wsocket.myJid = jidNormalizedUser(wsocket.user.id);

              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              logger.debug(
                {
                  id: jidNormalizedUser(wsocket.user.id),
                  name: wsocket.user.name,
                  lid: jidNormalizedUser(wsocket.user?.lid),
                  notify: wsocket.user?.notify,
                  verifiedName: wsocket.user?.verifiedName,
                  imgUrl: wsocket.user?.imgUrl,
                  status: wsocket.user?.status
                },
                `Session ${name} details`
              );

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

              if (wsocket.isRefreshing) {
                setTimeout(() => {
                  wsocket
                    .resyncAppState(
                      [
                        "critical_block",
                        "critical_unblock_low",
                        "regular_high",
                        "regular_low",
                        "regular"
                      ],
                      true
                    )
                    .catch(error => {
                      logger.error(
                        { message: error.message },
                        `Error resyncing app state for session ${name}`
                      );
                    });
                }, 5000);
                wsocket.isRefreshing = false;
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
        wsocket.ev.on("creds.update", saveState);

        wsocket.ev.on(
          "presence.update",
          async ({ id: remoteJid, presences }) => {
            try {
              logger.debug(
                { remoteJid, presences },
                "Received contact presence"
              );
              if (!presences[remoteJid]?.lastKnownPresence) {
                // ignore presence from groups
                return;
              }
              const contact = await Contact.findOne({
                where: {
                  number: remoteJid.replace(/\D/g, "")
                }
              });
              if (!contact) {
                return;
              }
              const ticket = await Ticket.findOne({
                where: {
                  contactId: contact.id,
                  whatsappId: whatsapp.id,
                  status: {
                    [Op.or]: ["open", "pending"]
                  }
                }
              });
              console.log("presence!")
              console.log(ticket)

            } catch (error) {
              logger.error(
                { remoteJid, presences },
                "presence.update: error processing"
              );
              if (error instanceof Error) {
                logger.error(`Error: ${error.name} ${error.message}`);
              } else {
                logger.error(`Error was object of type: ${typeof error}`);
              }
            }
          }
        );
        // wsocket.store = store;
        // store.bind(wsocket.ev);
      })();
    } catch (error) {
      console.log(error);
      reject(error);
    }
  });
};

const decoupledDriverServices = DecoupledDriverServices.getInstance();

decoupledDriverServices.registerFunction(
  "presenceUpdate",
  async (user, parameters) => {
    const { ticketId, presence } = parameters;
    const ticket = await ShowTicketService(ticketId);

    const wbot = await GetTicketWbot(ticket);
    if (!wbot) {
      return;
    }

    const jid = getJidOf(ticket);

    if (jid.endsWith("@lid")) {
      return;
    }

    wbot.sendPresenceUpdate(presence, jid).catch(err => {
      logger.error(
        {
          message: err.message,
          jid,
          presence,
          ticketId: ticket.id,
          connection: ticket.whatsapp?.name
        },
        "Error sending presence update"
      );
    });
  }
);
