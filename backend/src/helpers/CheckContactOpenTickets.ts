import { Op } from "sequelize";
import AppError from "../errors/AppError";
import Ticket from "../models/Ticket";
import Queue from "../models/Queue";
import User from "../models/User";

const CheckContactOpenTickets = async (contactId: number): Promise<void> => {
  const ticket = await Ticket.findOne({
    where: { contactId, status: { [Op.or]: ["open", "pending"] } }
  });

  if (ticket) {

    let vQueue = await Queue.findOne({
      where: { id: [ticket.queueId] }
    });

    let vUser = await User.findOne({
      where: { id: [ticket.userId] }
    });

    throw new AppError("Já existe um ticket aberto para este contato. \r\n" +
      "Setor: " + vQueue?.name + "  \r\n  Atendente: " + vUser?.name);
  }
};

export default CheckContactOpenTickets;
