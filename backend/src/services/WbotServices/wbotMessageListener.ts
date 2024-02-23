import { join } from "path";
import { promisify } from "util";
import { writeFile } from "fs";
import * as Sentry from "@sentry/node";

import {
  jidNormalizedUser,
  MessageUpsertType,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
  getContentType,
  extractMessageContent,
  WAMessageStubType,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";

import { getIO } from "../../libs/socket";
import CreateMessageService from "../MessageServices/CreateMessageService";
import { logger } from "../../utils/logger";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import formatBody from "../../helpers/Mustache";
import { Store } from "../../libs/store";
import Setting from "../../models/Setting";
import { debounce } from "../../helpers/Debounce";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import { sayChatbot } from "./ChatBotListener";
import hourExpedient from "./hourExpedient";
import { Configuration, OpenAIApi } from 'openai';

const organization = process.env.GPT_ORGANIZATION || "";
const apiKey = process.env.GPT_APIKEY || "";

const configuration = new Configuration({
  organization: organization,
  apiKey: apiKey,
});

const openai = new OpenAIApi(configuration);

const getDavinciResponse = async (clientText: string) => {
  const options = {
    model: 'text-davinci-003', // Model to be used
    prompt: clientText, // User-sent text
    temperature: 1, // Level of variation of generated responses, 1 is the maximum
    max_tokens: 4000, // Number of tokens (words) to be returned by the bot, 4000 is the maximum
  };

  try {
    const response = await openai.createCompletion(options);
    let botResponse = '';
    response.data.choices.forEach(({ text }) => {
      botResponse += text;
    });
    return `🤖 SENAI ChatGPT :\n\n${botResponse.trim()}\n\n🚀 Sempre acompanhando as novas tecnologias o SENAI proporciona experiências como esta. Compartilhe com seus amigos!\n\n⚠️ O SENAI MS não se responsabiliza pelos conteúdos gerados.\n\n👉 O conteúdo acima foi gerado através da Inteligência Artificial ChatGPT, saiba mais em https://openai.com/.`;
  } catch (e) {
    return `❌ Erro! O ChatGPT possui algumas limitações quanto ao uso e disponibilidade do serviço.\n\n💬 Refaça sua busca de um modo diferente.\n\n⏳ Ou aguarde o retorno do serviço.\n\nDescrição do erro:\n${e.response.data.error.message}`;
  }
};

const getDalleResponse = async (clientText: string): Promise<string> => {
  const options: any = {
  prompt: clientText, // Descrição da imagem
  n: 1, // Número de imagens a serem geradas
  size: "1024x1024", // Tamanho da imagem
  }
  try {
      const response = await openai.createImage(options);
      return response.data.data[0].url;
  } catch (e) {
      return `❌ Erro! O ChatGPT possui algumas limitações quanto ao uso e disponibilidade do serviço.\n\n💬 Refaça sua busca de um modo diferente.\n\n⏳ Ou aguarde o retorno do serviço.\n\nDescrição do erro:\n${e.response.data.error.message}`;
  }
};

type Session = WASocket & {
  id?: number;
  store?: Store;
};

interface ImessageUpsert {
  messages: proto.IWebMessageInfo[];
  type: MessageUpsertType;
}

interface IMe {
  name: string;
  id: string;
}

interface IMessage {
  messages: WAMessage[];
  isLatest: boolean;
}

const writeFileAsync = promisify(writeFile);

const getTypeMessage = (msg: proto.IWebMessageInfo): string => {
  return getContentType(msg.message);
};

const getBodyButton = (msg: proto.IWebMessageInfo): string => {
  try {
    if (msg?.message?.buttonsMessage?.contentText) {
      let bodyMessage = `*${msg?.message?.buttonsMessage?.contentText}*`;
      // eslint-disable-next-line no-restricted-syntax
      for (const buton of msg.message?.buttonsMessage?.buttons) {
        bodyMessage += `\n\n${buton.buttonText.displayText}`;
      }
      return bodyMessage;
    }
    if (msg?.message?.listMessage) {
      let bodyMessage = `*${msg?.message?.listMessage?.description}*`;
      // eslint-disable-next-line no-restricted-syntax
      for (const buton of msg.message?.listMessage?.sections[0]?.rows) {
        bodyMessage += `\n\n${buton.title}`;
      }
      return bodyMessage;
    }
    if (msg.message?.viewOnceMessage?.message?.listMessage) {
      const obj = msg.message?.viewOnceMessage?.message.listMessage;
      let bodyMessage = `*${obj.description}*`;
      // eslint-disable-next-line no-restricted-syntax
      for (const buton of obj.sections[0]?.rows) {
        bodyMessage += `\n\n${buton.title}`;
      }

      return bodyMessage;
    }
    if (msg.message?.viewOnceMessage?.message?.buttonsMessage) {
      const obj = msg.message?.viewOnceMessage?.message.buttonsMessage;
      let bodyMessage = `*${obj.contentText}*`;
      // eslint-disable-next-line no-restricted-syntax
      for (const buton of obj?.buttons) {
        bodyMessage += `\n\n${buton.buttonText.displayText}`;
      }
      return bodyMessage;
    }
  } catch (error) {
    logger.error(error);
  }
};

const msgLocation = (
  image: ArrayBuffer,
  latitude: number,
  longitude: number
) => {
  if (image) {
    const b64 = Buffer.from(image).toString("base64");

    const data = `data:image/png;base64, ${b64} | https://maps.google.com/maps?q=${latitude}%2C${longitude}&z=17&hl=pt-BR|${latitude}, ${longitude} `;
    return data;
  }
};

export const getBodyMessage = (msg: proto.IWebMessageInfo): string | null => {
  try {
    const type = getTypeMessage(msg);
    if (!type) {
      console.log("não achou o  type 90");
      return;
    }

    const types = {
      conversation: msg.message.conversation,
      imageMessage: msg.message.imageMessage?.caption,
      videoMessage: msg.message.videoMessage?.caption,
      extendedTextMessage:
        getBodyButton(msg) ||
        msg.message.extendedTextMessage?.text ||
        msg.message?.listMessage?.description,
      buttonsResponseMessage:
        msg.message.buttonsResponseMessage?.selectedDisplayText,
      listResponseMessage:
        msg?.message?.listResponseMessage?.title || "Chegou Aqui",
      templateButtonReplyMessage:
        msg.message?.templateButtonReplyMessage?.selectedId,
      messageContextInfo:
        msg.message.buttonsResponseMessage?.selectedButtonId ||
        msg.message.listResponseMessage?.title,
      buttonsMessage:
        getBodyButton(msg) || msg.message.listResponseMessage?.title,
      stickerMessage: "sticker",
      contactMessage: msg.message.contactMessage?.vcard,
      contactsArrayMessage: "varios contatos",
      locationMessage: msgLocation(
        msg.message?.locationMessage?.jpegThumbnail,
        msg.message?.locationMessage?.degreesLatitude,
        msg.message?.locationMessage?.degreesLongitude
      ),
      liveLocationMessage: `Latitude: ${msg.message.liveLocationMessage?.degreesLatitude} - Longitude: ${msg.message.liveLocationMessage?.degreesLongitude}`,
      documentMessage: msg.message.documentMessage?.title,
      audioMessage: "Áudio",
      reactionMessage: msg.message?.reactionMessage?.text,
      ephemeralMessage:
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text,
      protocolMessage: msg.message?.protocolMessage?.type,
      listMessage: getBodyButton(msg) || msg.message?.listMessage?.description,
      viewOnceMessage: getBodyButton(msg)
    };

    const objKey = Object.keys(types).find(objKeyz => objKeyz === type);

    if (!objKey) {
      logger.warn(`#### Nao achou o type em getBodyMessage: ${type}
${JSON.stringify(msg?.message)}`);
      Sentry.setExtra("Mensagem", { BodyMsg: msg.message, msg, type });
      Sentry.captureException(
        new Error("Novo Tipo de Mensagem em getBodyMessage")
      );
    }

    return types[type];
  } catch (error) {
    Sentry.setExtra("Error getTypeMessage", { msg, BodyMsg: msg.message });
    Sentry.captureException(error);
    console.log(error);
  }
};

export const getQuotedMessage = (msg: proto.IWebMessageInfo): any => {
  const body = extractMessageContent(msg.message)[
    Object.keys(msg?.message).values().next().value
  ];

  if (!body?.contextInfo?.quotedMessage) return;
  const quoted = extractMessageContent(
    body?.contextInfo?.quotedMessage[
      Object.keys(body?.contextInfo?.quotedMessage).values().next().value
    ]
  );

  return quoted;
};

const getMeSocket = (wbot: Session): IMe => {
  return {
        id: jidNormalizedUser((wbot as WASocket).user.id),
        name: (wbot as WASocket).user.name
  };
};

const getSenderMessage = (
  msg: proto.IWebMessageInfo,
  wbot: Session
): string => {
  const me = getMeSocket(wbot);
  if (msg.key.fromMe) return me.id;

  const senderId =
    msg.participant || msg.key.participant || msg.key.remoteJid || undefined;

  return senderId && jidNormalizedUser(senderId);
};

const getContactMessage = async (msg: proto.IWebMessageInfo, wbot: Session) => {

  const isGroup = msg.key.remoteJid.includes("g.us");
  const rawNumber = msg.key.remoteJid.replace(/\D/g, "");
  return isGroup
    ? {
        id: getSenderMessage(msg, wbot),
        name: msg.pushName
      }
    : {
        id: msg.key.remoteJid,
        name: msg.key.fromMe ? rawNumber : msg.pushName
      };
};

const downloadMedia = async (msg: proto.IWebMessageInfo, wbot: Session) => {
  const mineType =
    msg.message?.imageMessage ||
    msg.message?.audioMessage ||
    msg.message?.videoMessage ||
    msg.message?.stickerMessage ||
    msg.message?.documentMessage;

  const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      { },
      {
          logger,
          // pass this so that baileys can request a reupload of media
          // that has been deleted
          reuploadRequest: wbot.updateMediaMessage
      }
  )

  let filename = msg.message?.documentMessage?.fileName || "";

  if (!filename) {
    const ext = mineType.mimetype.split("/")[1].split(";")[0];
    filename = `${new Date().getTime()}.${ext}`;
  }

  const media = {
    data: buffer,
    mimetype: mineType.mimetype,
    filename
  };

  return media;
};

const verifyContact = async (
  msgContact: IMe,
  wbot: Session
): Promise<Contact> => {
  let profilePicUrl: string;
  try {
    profilePicUrl = await wbot.profilePictureUrl(msgContact.id);
  } catch {
    profilePicUrl = `${process.env.FRONTEND_URL}/nopicture.png`;
  }

  const contactData = {
    name: msgContact?.name || msgContact.id.replace(/\D/g, ""),
    number: msgContact.id.replace(/./g, (a) => { if(a === '-' || a.match(/\d/)) {return a;} return '' }),
    profilePicUrl,
    isGroup: msgContact.id.includes("g.us")
  };

  const contact = CreateOrUpdateContactService(contactData);

  return contact;
};

export const getQuotedMessageId = (msg: proto.IWebMessageInfo): string => {
  const body = extractMessageContent(msg.message)[
    Object.keys(msg?.message).values().next().value
  ];

  return body?.contextInfo?.stanzaId;
};

const verifyQuotedMessage = async (
  msg: proto.IWebMessageInfo
): Promise<Message | null> => {
  if (!msg) return null;
  const quoted = getQuotedMessageId(msg);

  if (!quoted) return null;

  const quotedMsg = await Message.findOne({
    where: { id: quoted }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

// generate random id string for file names, function got from: https://stackoverflow.com/a/1349426/1851801
function makeRandomId(length: number) {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
}

const verifyMediaMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact,
  wbot: Session
): Promise<Message> => {
  const quotedMsg = await verifyQuotedMessage(msg);

  const media = await downloadMedia(msg, wbot);

  if (!media) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  let randomId = makeRandomId(5);

  if (!media.filename) {
      const ext = media.mimetype.split("/")[1].split(";")[0];
      media.filename = `${new Date().getTime()}.${ext}`;
      media.filename = `${randomId}-${new Date().getTime()}.${ext}`;
    } else {
      media.filename = media.filename.split('.').slice(0,-1).join('.')+'.'+randomId+'.'+media.filename.split('.').slice(-1);
  }

  try {
    const ext = media.mimetype.split("/")[1].split(";")[0];
    media.filename = `${new Date().getTime()} - ${media.filename}`;
    await writeFileAsync(
      join(__dirname, "..", "..", "..", "public", media.filename),
      media.data,
      "base64"
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(err);
  }

  const body = getBodyMessage(msg);
  const messageData = {
    id: msg.key.id,
    ticketId: ticket.id,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body: body || media.filename,
    fromMe: msg.key.fromMe,
    read: msg.key.fromMe,
    mediaUrl: media.filename,
    mediaType: media.mimetype.split("/")[0],
    quotedMsgId: quotedMsg?.id,
    ack: msg.status,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg)
  };

  await ticket.update({
    lastMessage: body || media.filename
  });

  const newMessage = await CreateMessageService({ messageData });

  return newMessage;
};

export const verifyMessage = async (
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact
): Promise<Message> => {
  const quotedMsg = await verifyQuotedMessage(msg);
  const body = getBodyMessage(msg);

  const messageData = {
    id: msg.key.id,
    ticketId: ticket.id,
    contactId: msg.key.fromMe ? undefined : contact.id,
    body,
    fromMe: msg.key.fromMe,
    mediaType: getTypeMessage(msg),
    read: msg.key.fromMe,
    quotedMsgId: quotedMsg?.id,
    ack: msg.status,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant,
    dataJson: JSON.stringify(msg)
  };

  await ticket.update({
    lastMessage: body
  });

  return CreateMessageService({ messageData });
};

const isValidMsg = (msg: proto.IWebMessageInfo): boolean => {
  if (msg.key.remoteJid === "status@broadcast") return false;
  const msgType = getTypeMessage(msg);
  const ifType =
    msgType === "conversation" ||
    msgType === "extendedTextMessage" ||
    msgType === "audioMessage" ||
    msgType === "videoMessage" ||
    msgType === "imageMessage" ||
    msgType === "documentMessage" ||
    msgType === "stickerMessage" ||
    msgType === "buttonsResponseMessage" ||
    msgType === "listResponseMessage" ||
    msgType === "listMessage";

  return !!ifType;
};

const verifyQueue = async (
  wbot: Session,
  msg: proto.IWebMessageInfo,
  ticket: Ticket,
  contact: Contact
) => {
  const { queues, greetingMessage } = await ShowWhatsAppService(wbot.id!);

  if (queues.length === 1) {
    await UpdateTicketService({
      ticketData: { queueId: queues[0].id },
      ticketId: ticket.id
    });

    return;
  }

  const selectedOption =
    msg?.message?.buttonsResponseMessage?.selectedButtonId ||
    msg?.message?.listResponseMessage?.singleSelectReply.selectedRowId ||
    getBodyMessage(msg);

  const choosenQueue = queues[+selectedOption - 1];

  const buttonActive = await Setting.findOne({
    where: {
      key: "chatBotType"
    }
  });

  const botText = async () => {

    if (choosenQueue) {
      await UpdateTicketService({
        ticketData: { queueId: choosenQueue.id },
        ticketId: ticket.id
      });

      if (choosenQueue.chatbots.length > 0) {
        let options = "";
        choosenQueue.chatbots.forEach((chatbot, index) => {
          options += `*${index + 1}* - ${chatbot.name}\n`;
        });

        const body = formatBody(
          `\u200e${choosenQueue.greetingMessage}\n\n${options}\n*#* Voltar para o menu principal`,
          contact
        );
        const sentMessage = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: body
          }
        );

        await verifyMessage(sentMessage, ticket, contact);
      }

      if (!choosenQueue.chatbots.length) {
        const body = formatBody(
          `\u200e${choosenQueue.greetingMessage}`,
          contact
        );
        const sentMessage = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: body
          }
        );

        await verifyMessage(sentMessage, ticket, contact);
      }
    } else {
      let options = "";

      queues.forEach((queue, index) => {
        options += `*${index + 1}* - ${queue.name}\n`;
      });

      const body = formatBody(
        `\u200e${greetingMessage}\n\n${options}`,
        contact
      );

      const debouncedSentMessage = debounce(
        async () => {
          const sentMessage = await wbot.sendMessage(
            `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
            {
              text: body
            }
          );

          verifyMessage(sentMessage, ticket, contact);
        },
        3000,
        ticket.id
      );

      debouncedSentMessage();
    }
  };

  const botButton = async () => {
    if (choosenQueue) {
      await UpdateTicketService({
        ticketData: { queueId: choosenQueue.id },
        ticketId: ticket.id
      });

      if (choosenQueue.chatbots.length > 0) {
        const buttons = [];
        choosenQueue.chatbots.forEach((queue, index) => {
          buttons.push({
            buttonId: `${index + 1}`,
            buttonText: { displayText: queue.name },
            type: 1
          });
        });

        const buttonMessage = {
          text: formatBody(`\u200e${choosenQueue.greetingMessage}`, contact),
          buttons,
          headerType: 4
        };

        const sendMsg = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          buttonMessage
        );

        await verifyMessage(sendMsg, ticket, contact);
      }

      if (!choosenQueue.chatbots.length) {
        const body = formatBody(
          `\u200e${choosenQueue.greetingMessage}`,
          contact
        );
        const sentMessage = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: body
          }
        );

        await verifyMessage(sentMessage, ticket, contact);
      }
    } else {
      const buttons = [];
      queues.forEach((queue, index) => {
        buttons.push({
          buttonId: `${index + 1}`,
          buttonText: { displayText: queue.name },
          type: 4
        });
      });

      const buttonMessage = {
        text: formatBody(`\u200e${greetingMessage}`, contact),
        buttons,
        headerType: 4
      };

      const sendMsg = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        buttonMessage
      );

      await verifyMessage(sendMsg, ticket, contact);
    }
  };

  const botList = async () => {
    if (choosenQueue) {
      await UpdateTicketService({
        ticketData: { queueId: choosenQueue.id },
        ticketId: ticket.id
      });

      if (choosenQueue.chatbots.length > 0) {
        const sectionsRows = [];
        choosenQueue.chatbots.forEach((queue, index) => {
          sectionsRows.push({
            title: queue.name,
            rowId: `${index + 1}`
          });
        });

        const sections = [
          {
            title: "Menu",
            rows: sectionsRows
          }
        ];

        const listMessage = {
          text: formatBody(`\u200e${choosenQueue.greetingMessage}`, contact),
          buttonText: "Escolha uma opção",
          sections
        };

        const sendMsg = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          listMessage
        );

        await verifyMessage(sendMsg, ticket, contact);
      }

      if (!choosenQueue.chatbots.length) {
        const body = formatBody(
          `\u200e${choosenQueue.greetingMessage}`,
          contact
        );

        const sentMessage = await wbot.sendMessage(
          `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: body
          }
        );

        await verifyMessage(sentMessage, ticket, contact);
      }
    } else {
      const sectionsRows = [];

      queues.forEach((queue, index) => {
        sectionsRows.push({
          title: queue.name,
          rowId: `${index + 1}`
        });
      });

      const sections = [
        {
          title: "Menu",
          rows: sectionsRows
        }
      ];

      const listMessage = {
        text: formatBody(`\u200e${greetingMessage}`, contact),
        buttonText: "Escolha uma opção",
        sections
      };

      const sendMsg = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        listMessage
      );

      await verifyMessage(sendMsg, ticket, contact);
    }
  };

  if (buttonActive.value === "text") {
    return botText();
  }

  if (buttonActive.value === "button" && queues.length > 4) {
    return botText();
  }

  if (buttonActive.value === "button" && queues.length <= 4) {
    return botButton();
  }

  if (buttonActive.value === "list") {
    return botList();
  }
};

const handleMessage = async (
  msg: proto.IWebMessageInfo,
  wbot: Session
): Promise<void> => {
  if (!isValidMsg(msg)) return;
  try {
    let msgContact: IMe;
    let groupContact: Contact | undefined;

    const isGroup = msg.key.remoteJid?.endsWith("@g.us");

    const msgIsGroupBlock = await Setting.findOne({
      where: { key: "CheckMsgIsGroup" }
    });

    const enableGPT = await Setting.findOne({
      where: { key: "EnableGPT" }
    });

    const bodyMessage = getBodyMessage(msg);
    const msgType = getTypeMessage(msg);

    const hasMedia =
      msg.message?.audioMessage ||
      msg.message?.imageMessage ||
      msg.message?.videoMessage ||
      msg.message?.documentMessage ||
      msg.message.stickerMessage;

    if (msg.key.fromMe) {
      if (/\u200e/.test(bodyMessage)) return;

      if (
        !hasMedia &&
        msgType !== "conversation" &&
        msgType !== "extendedTextMessage" &&
        msgType !== "vcard"
      )
        return;
      msgContact = await getContactMessage(msg, wbot);
    } else {
      msgContact = await getContactMessage(msg, wbot);
    }

    if (msgIsGroupBlock?.value === "enabled" && isGroup) return;

    if (isGroup) {
      const grupoMeta = await wbot.groupMetadata(msg.key.remoteJid);
      const msgGroupContact = {
        id: grupoMeta.id,
        name: grupoMeta.subject
      };
      groupContact = await verifyContact(msgGroupContact, wbot);
    }
    const whatsapp = await ShowWhatsAppService(wbot.id!);

    const count = wbot.store.chats.get(
      msg.key.remoteJid || msg.key.participant
    );

    const unreadMessages = msg.key.fromMe ? 0 : count?.unreadCount || 1;

    const contact = await verifyContact(msgContact, wbot);

    if (
      unreadMessages === 0 &&
      whatsapp.farewellMessage &&
      formatBody(whatsapp.farewellMessage, contact) === bodyMessage
    )
      return;

    const ticket = await FindOrCreateTicketService({
      contact,
      whatsappId: wbot.id!,
      unreadMessages,
      groupContact,
      channel: "whatsapp"
    });

    if (hasMedia) {
      await verifyMediaMessage(msg, ticket, contact, wbot);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    const checkExpedient = await hourExpedient();
    if (checkExpedient) {
    if (
      !ticket.queue &&
      !isGroup &&
      !msg.key.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      await verifyQueue(wbot, msg, ticket, contact);
    }

    if (ticket.queue && ticket.queueId) {
      if (!ticket.user) {
        await sayChatbot(ticket.queueId, wbot, ticket, contact, msg);
      }
    }

  } else {
      const getLastMessageFromMe = await Message.findOne({
        where: {
          ticketId: ticket.id,
          fromMe: true
        },
        order: [["createdAt", "DESC"]]
      });

      if (
        getLastMessageFromMe?.body ===
        formatBody(`\u200e${whatsapp.outOfWorkMessage}`, contact)
      )
      return;

      const body = formatBody(`\u200e${whatsapp.outOfWorkMessage}`, contact);
      const sentMessage = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        {
          text: body
        }
      );

      await verifyMessage(sentMessage, ticket, contact);
    }

  if (enableGPT?.value === "disabled" || organization === "" || apiKey === "") return;

  const msgChatGPT = msg.message.conversation;

  if ( msgChatGPT.toLowerCase().includes("/botsenai") && !msgChatGPT.toLowerCase().includes(" senai") && !msgChatGPT.toLowerCase().includes(" sesi") && !msgChatGPT.toLowerCase().includes(" iel") && !msgChatGPT.toLowerCase().includes(" fiems")) {
    const index = msgChatGPT.indexOf(' ');
    const question = msgChatGPT.substring(index + 1);
    const response = await getDavinciResponse(question);
    //console.log('RESULT: ', response);
    const body = formatBody(response, contact);
      const sentMessage = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        {
          text: body
        }
      );

  }

  if ( msgChatGPT.includes("/imgsenai") ) {
    const index = msgChatGPT.indexOf(' ');
    const imgDescription = msgChatGPT.substring(index + 1);
    const imgUrl = await getDalleResponse(imgDescription);
    const ZDGImagem = {
      caption: "Imagem gerada por Inteligência Artificial",
      image: {
        url: imgUrl,
      },
    };
    //console.log('RESULT: ', ZDGImagem);
    const sentMessage = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        {
          ...ZDGImagem
        }
      );
    const sentMessage2 = await wbot.sendMessage(
        `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
        {
          text: `🚀 Sempre acompanhando as novas tecnologias o SENAI proporciona experiências como esta. Compartilhe com seus amigos!\n\n⚠️ O SENAI MS não se responsabiliza pelos conteúdos gerados.\n\n👉 O conteúdo acima foi gerado através da Inteligência Artificial Dall-E 2, saiba mais em https://openai.com/.`
        }
      );
  }

  } catch (err) {
    console.log(err);
    Sentry.captureException(err);
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

const handleMsgAck = async (
  msg: WAMessage,
  chat: number | null | undefined
) => {
  await new Promise(r => setTimeout(r, 500));
  const io = getIO();
  try {
    const messageToUpdate = await Message.findByPk(msg.key.id, {
      include: [
        "contact",
        {
          model: Message,
          as: "quotedMsg",
          include: ["contact"]
        }
      ]
    });

    if (!messageToUpdate) return;
    await messageToUpdate.update({ ack: chat });
    io.to(messageToUpdate.ticketId.toString()).emit("appMessage", {
      action: "update",
      message: messageToUpdate
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling message ack. Err: ${err}`);
  }
};

const filterMessages = (msg: WAMessage): boolean => {
  if (msg.message?.protocolMessage) return false;

  if (
    [
      WAMessageStubType.REVOKE,
      WAMessageStubType.E2E_DEVICE_CHANGED,
      WAMessageStubType.E2E_IDENTITY_CHANGED,
      WAMessageStubType.CIPHERTEXT
    ].includes(msg.messageStubType as WAMessageStubType)
  )
    return false;

  return true;
};

const wbotMessageListener = async (wbot: Session): Promise<void> => {
  try {
    wbot.ev.on("messages.upsert", async (messageUpsert: ImessageUpsert) => {
      const messages = messageUpsert.messages
        .filter(filterMessages)
        .map(msg => msg);

      if (!messages) return;

      messages.forEach(async (message: proto.IWebMessageInfo) => {
        if (
          wbot.type === "md" &&
          !message.key.fromMe &&
          messageUpsert.type === "notify"
        ) {
          if (message.key.remoteJid != "status@broadcast") (wbot as WASocket)!.readMessages([message.key]);
        }

        //console.log(JSON.stringify(message));
        handleMessage(message, wbot);

      });
    });

    wbot.ev.on("messages.update", (messageUpdate: WAMessageUpdate[]) => {
      if (messageUpdate.length === 0) return;
      messageUpdate.forEach(async (message: WAMessageUpdate) => {
        handleMsgAck(message, message.update.status);
      });
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error(`Error handling wbot message listener. Err: ${error}`);
  }
};

export { wbotMessageListener, handleMessage };
