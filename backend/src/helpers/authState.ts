import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import * as Sentry from "@sentry/node";

import Whatsapp from "../models/Whatsapp";

const KEY_MAP: { [T in keyof SignalDataTypeMap]: string } = {
  "pre-key": "preKeys",
  session: "sessions",
  "sender-key": "senderKeys",
  "app-state-sync-key": "appStateSyncKeys",
  "app-state-sync-version": "appStateVersions",
  "sender-key-memory": "senderKeyMemory"
};

const authState = async (
  whatsapp: Whatsapp
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  let creds: AuthenticationCreds;
  let keys: any = {};

  const saveState = async () => {
    try {
      await whatsapp.update({
        session: JSON.stringify({ creds, keys }, BufferJSON.replacer, 0)
      });
      return null;
    } catch (error) {
      Sentry.captureException(error);
      return null;
    }
  };

  if (whatsapp.session && whatsapp.session !== null) {
    const result = JSON.parse(whatsapp.session, BufferJSON.reviver);
    creds = result.creds;
    keys = result.keys;
  } else {
    creds = initAuthCreds();
    keys = {};
  }

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const key = KEY_MAP[type];
          return ids.reduce((dict: any, id) => {
            let value = keys[key]?.[id];
            if (value) {
              if (type === "app-state-sync-key") {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              dict[id] = value;
            }

            return dict;
          }, {});
        },
        set: async (data: any) => {
          for (const _key in data) {
            const key = KEY_MAP[_key as keyof SignalDataTypeMap];
            keys[key] = keys[key];
            if (!keys[key]) keys[key] = {};
            Object.assign(keys[key], data[_key]);
          }

          await saveState();
        }
      }
    },
    saveCreds: () => {
      return saveState();
    }
  };
};

export default authState;
