import React, { useEffect, useState } from 'react';
import { useHistory } from "react-router-dom";
import toastError from "../../errors/toastError";
import api from "../../services/api";

import Avatar from "@material-ui/core/Avatar";
import Typography from "@material-ui/core/Typography";
import Grid from "@material-ui/core/Grid";
import { Button, Divider, } from "@material-ui/core";
import NewTicketModal from "../NewTicketModal";

const VcardPreview = ({ contact, numbers }) => {
    const history = useHistory();
    const [newTicketModalOpen, setNewTicketModalOpen] = useState(false);

    const [selectedContact, setContact] = useState({
        name: "",
        number: 0,
        profilePicUrl: ""
    });

    useEffect(() => {
        const delayDebounceFn = setTimeout(() => {
            const number = numbers?.replace(/\D/g, "");
            let chatId;
            let numberDDI;
            let numberDDD;
            let numberUser;

            if (number?.toString().substr(0, 2) === "55" && number !== undefined) {
                numberDDI = number.toString().substr(0, 2);
                numberDDD = number.toString().substr(2, 2);
                numberUser = number.toString().substr(-8, 8);
            }

            if (numberDDD <= '30' && numberDDI === '55') {
                chatId = `${numberDDI + numberDDD + 9 + numberUser}@s.whatsapp.net`;
            } else if (numberDDD > '30' && numberDDI === '55') {
                chatId = `${numberDDI + numberDDD + numberUser}@s.whatsapp.net`;
            } else {
                chatId = `${numbers}@s.whatsapp.net`;
            }


            const fetchContacts = async () => {
                try {
                    let contactObj = {
                        name: contact,
                        number: chatId !== undefined && chatId.replace(/\D/g, ""),
                    }

                    const { data } = await api.get("/contact/", {
                        params: contactObj
                    });

                    if (!data.id) {
                        const { data } = await api.post("/contact", contactObj);
                        setContact(data)
                    } else {
                        setContact(data)
                    }

                } catch (err) {
                    console.log(err)
                    toastError(err);
                }
            };
            fetchContacts();
        }, 500);
        return () => clearTimeout(delayDebounceFn);
    }, [contact, numbers]);

    const handleCloseOrOpenTicket = (ticket) => {
        setNewTicketModalOpen(false);
        if (ticket !== undefined && ticket.uuid !== undefined) {
            history.push(`/tickets/${ticket.uuid}`);
        }
    };

    return (
        <>
            <NewTicketModal
                modalOpen={newTicketModalOpen}
                onClose={(ticket) => {
                    console.log("ticket", ticket);
                    handleCloseOrOpenTicket(ticket);
                }}
                initialContact={selectedContact}
            />
            <div style={{
                minWidth: "250px",
            }}>
                <Grid container spacing={0}>
                    <Grid
                        style={{
                            justifyContent: "center",
                            display: "flex"
                        }}
                        item xs={12}>
                        <Avatar src={selectedContact?.profilePicUrl} />
                    </Grid>
                    <Grid
                        style={{
                            justifyContent: "center",
                            display: "flex"
                        }}
                        item xs={12}>
                        <Typography
                            variant="subtitle1"
                            // color="secondary"
                            gutterBottom>
                            {selectedContact.name}
                        </Typography>
                    </Grid>
                    <Grid item xs={12}>
                        <Divider />
                        <Button
                            fullWidth
                            color="primary"
                            onClick={() => setNewTicketModalOpen(true)}
                            disabled={!selectedContact.number}
                        >{!selectedContact.number ? "Número Inválido" : "Conversar"}</Button>
                    </Grid>
                </Grid>
            </div>
        </>
    );

};

export default VcardPreview;