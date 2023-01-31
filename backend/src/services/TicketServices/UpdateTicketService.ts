import moment from "moment";
import * as Sentry from "@sentry/node";
import CheckContactOpenTickets from "../../helpers/CheckContactOpenTickets";
import SetTicketMessagesAsRead from "../../helpers/SetTicketMessagesAsRead";
import { getIO } from "../../libs/socket";
import Ticket from "../../models/Ticket";
import Setting from "../../models/Setting";
import Queue from "../../models/Queue";
import ShowTicketService from "./ShowTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import SendWhatsAppMessage from "../WbotServices/SendWhatsAppMessage";
import FindOrCreateATicketTrakingService from "./FindOrCreateATicketTrakingService";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import { verifyMessage } from "../WbotServices/wbotMessageListener";
import { isNil } from "lodash";
import User from "../../models/User";

interface TicketData {
  status?: string;
  userId?: number | null;
  queueId?: number | null;
  isBot?: boolean;
  queueOptionId?: number;
}

interface Request {
  ticketData: TicketData;
  ticketId: string | number;
  companyId: number;
}

interface Response {
  ticket: Ticket;
  oldStatus: string;
  oldUserId: number | undefined;
}

const UpdateTicketService = async ({
  ticketData,
  ticketId,
  companyId
}: Request): Promise<Response> => {
  try {
    const { status } = ticketData;
    let { queueId, userId } = ticketData;
    let isBot: boolean | null = ticketData.isBot || false;
    let queueOptionId: number | null = ticketData.queueOptionId || null;

    const io = getIO();
    const key = "userRating";
    const setting = await Setting.findOne({
      where: {
        companyId,
        key
      }
    });

    const ticket = await ShowTicketService(ticketId, companyId);
    const ticketTraking = await FindOrCreateATicketTrakingService({
      ticketId,
      companyId,
      whatsappId: ticket.whatsappId
    });

    if (ticket.channel === "whatsapp") {

      await SetTicketMessagesAsRead(ticket);

    }

    const oldStatus = ticket.status;
    const oldUserId = ticket.user?.id;
    const oldQueueId = ticket.queueId;
    const companySetting = await Setting.findOne({ where: { companyId: companyId, key: 'msg_auto'} });
    const msgAuto = companySetting?.value === 'enabled' ? true : false;

    if (oldStatus === "closed") {
      await CheckContactOpenTickets(ticket.contact.id);
      isBot = false;
      queueOptionId = null;
    }

    if (ticket.channel === "whatsapp") {

      if (status !== undefined && ["closed"].indexOf(status) > -1) {
        const { complationMessage, ratingMessage } = await ShowWhatsAppService(
          ticket.whatsappId,
          companyId
        );

        if (setting?.value === "enabled") {
          if (ticketTraking.ratingAt == null) {
            const ratingTxt = ratingMessage || "";
            let bodyRatingMessage = `\u200e${ratingTxt}\n\n`;
            bodyRatingMessage +=
              "Digite de 1 à 3 para qualificar nosso atendimento:\n*1* - _Insatisfeito_\n*2* - _Satisfeito_\n*3* - _Muito Satisfeito_";
            await SendWhatsAppMessage({ body: bodyRatingMessage, ticket });

            await ticketTraking.update({
              ratingAt: moment().toDate()
            });

            io.to("open")
              .to(ticketId.toString())
              .emit(`company-${ticket.companyId}-ticket`, {
                action: "delete",
                ticketId: ticket.id
              });

            return { ticket, oldStatus, oldUserId };
          }
          ticketTraking.ratingAt = moment().toDate();
          ticketTraking.rated = false;
        }

        if (!isNil(complationMessage) && complationMessage !== "") {
          const body = `\u200e${complationMessage}`;
          await SendWhatsAppMessage({ body, ticket });

          if (msgAuto) {
            const msg = `\u200e *_Mensagem Automática:_* \n ${ticket.user.name} finalizou a conversa!`;
            await SendWhatsAppMessage({ body: msg, ticket });
          }
        }

        ticketTraking.finishedAt = moment().toDate();
        ticketTraking.whatsappId = ticket.whatsappId;
        ticketTraking.userId = ticket.userId;

        queueId = null;
        userId = null;
      }
    }

    if (queueId !== undefined && queueId !== null) {
      ticketTraking.queuedAt = moment().toDate();
    }
    if (ticket.channel === "whatsapp") {
      if (oldQueueId !== queueId && !isNil(oldQueueId) && !isNil(queueId)) {
        const queue = await Queue.findByPk(queueId);
        const wbot = await GetTicketWbot(ticket);
        const oldUser = await User.findByPk(oldUserId);


        if (msgAuto) {
          const queueChangedMessage = await wbot.sendMessage(
            `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"
            }`,
            {
              text: `\u200e *_Mensagem Automática:_* \n O atendente *${oldUser.name}* te transferiu para a fila *${queue.name}*, por favor aguarde um de nossos atendentes!`
            }
          );
          await verifyMessage(queueChangedMessage, ticket);
        }

      } else if (oldUserId !== userId && !isNil(oldUserId) && !isNil(userId)) {
        const user = await User.findByPk(userId);
        const oldUser = await User.findByPk(oldUserId);
        const wbot = await GetTicketWbot(ticket);

        if (msgAuto) {
          const userChangedMessage = await wbot.sendMessage(
            `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"
            }`,
            {
              text: `\u200e *_Mensagem Automática:_* \n*${oldUser.name}* transferiu o seu atendimento para *${user.name}*.`
            }
          );
          await verifyMessage(userChangedMessage, ticket);

          const userMessage = await wbot.sendMessage(
            `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"
            }`,
            {
              text: `\u200e *_Mensagem Automática:_* \n ${user.name} iniciou o seu atendimento.`
            }
          );
          await verifyMessage(userMessage, ticket);
        } else {
          const queueChangedMessage = await wbot.sendMessage(
            `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"
            }`,
            {
              text: "\u200eVocê foi transferido, em breve iniciaremos seu atendimento."
            }
          );
          await verifyMessage(queueChangedMessage, ticket);
        }
      }
    }

    await ticket.update({
      status,
      queueId,
      userId,
      isBot,
      queueOptionId
    });

    await ticket.reload();

    if (status !== undefined && ["pending"].indexOf(status) > -1) {
      ticketTraking.update({
        whatsappId: ticket.whatsappId,
        queuedAt: moment().toDate(),
        startedAt: null,
        userId: null
      });
    }

    if (status !== undefined && ["open"].indexOf(status) > -1) {
      const user = await User.findByPk(userId);
      const wbot = await GetTicketWbot(ticket);

      const Hr = new Date();
      let hh: number = Hr.getHours();
      let ms = "";

      if (hh >= 0) {
        ms = "Bom dia";
      }
      if (hh > 12) {
        ms = "Boa tarde";
      }
      if (hh > 18) {
        ms = "Boa noite";
      }

      if (msgAuto) {
        const userMessage = await wbot.sendMessage(
          `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: `\u200e *_Mensagem Automática:_* \n ${user.name} iniciou o seu atendimento.`
          }
        );
        await verifyMessage(userMessage, ticket);

        const sendGrettingMessage = await wbot.sendMessage(
          `${ticket.contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`,
          {
            text: `\u200e *_Mensagem Automática:_* \n Olá, ${ms} \n meu nome é *${ticket.user.name}* como posso te ajudar?`
          }
        );
        await verifyMessage(sendGrettingMessage, ticket);
      }

      ticketTraking.update({
        startedAt: moment().toDate(),
        ratingAt: null,
        rated: false,
        whatsappId: ticket.whatsappId,
        userId: ticket.userId
      });
    }

    await ticketTraking.save();

    if (ticket.status !== oldStatus || ticket.user?.id !== oldUserId) {
      io.to(oldStatus).emit(`company-${companyId}-ticket`, {
        action: "delete",
        ticketId: ticket.id
      });
    }

    io.to(ticket.status)
      .to("notification")
      .to(ticketId.toString())
      .emit(`company-${companyId}-ticket`, {
        action: "update",
        ticket
      });

    return { ticket, oldStatus, oldUserId };
  } catch (err) {
    Sentry.captureException(err);
  }
};

export default UpdateTicketService;
