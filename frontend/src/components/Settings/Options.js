import React, { useEffect, useState } from "react";

import Grid from "@material-ui/core/Grid";
import MenuItem from "@material-ui/core/MenuItem";
import FormControl from "@material-ui/core/FormControl";
import InputLabel from "@material-ui/core/InputLabel";
import Select from "@material-ui/core/Select";
import FormHelperText from "@material-ui/core/FormHelperText";
import useSettings from "../../hooks/useSettings";

import { makeStyles } from "@material-ui/core/styles";
import { grey, blue } from "@material-ui/core/colors";
import { toast } from "react-toastify";
import { i18n } from "../../translate/i18n";
import toastError from "../../errors/toastError";

const useStyles = makeStyles((theme) => ({
  container: {
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(4),
  },
  fixedHeightPaper: {
    padding: theme.spacing(2),
    display: "flex",
    overflow: "auto",
    flexDirection: "column",
    height: 240,
  },
  cardAvatar: {
    fontSize: "55px",
    color: grey[500],
    backgroundColor: "#ffffff",
    width: theme.spacing(7),
    height: theme.spacing(7),
  },
  cardTitle: {
    fontSize: "18px",
    color: blue[700],
  },
  cardSubtitle: {
    color: grey[600],
    fontSize: "14px",
  },
  alignRight: {
    textAlign: "right",
  },
  fullWidth: {
    width: "100%",
  },
  selectContainer: {
    width: "100%",
    textAlign: "left",
  },
}));

export default function Options(props) {
  const { settings, scheduleTypeChanged } = props;
  const classes = useStyles();
  const [userRating, setUserRating] = useState("disabled");
  const [scheduleType, setScheduleType] = useState("disabled");
  const [chatBotType, setChatBotType] = useState("text");
  const [callType, setCallType] = useState("enabled");
  const [msgAutoType, setMsgAutoType] = useState("enabled");

  const [loadingUserRating, setLoadingUserRating] = useState(false);
  const [loadingScheduleType, setLoadingScheduleType] = useState(false);

  const { update } = useSettings();

  useEffect(() => {
    if (Array.isArray(settings) && settings.length) {
      const userRating = settings.find((s) => s.key === "userRating");
      if (userRating) {
        setUserRating(userRating.value);
      }
      const scheduleType = settings.find((s) => s.key === "scheduleType");
      if (scheduleType) {
        setScheduleType(scheduleType.value);
      }

      const chatBotType = settings.find((s) => s.key === "chatBotType");
      if (chatBotType) {
        setChatBotType(chatBotType.value);
      }

      const callType = settings.find((s) => s.key === "call");
      if (callType) {
        setCallType(callType.value);
      }

      const msgAutoType = settings.find((s) => s.key === "msg_auto");
      if (msgAutoType) {
        setMsgAutoType(msgAutoType.value);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  async function handleChangeUserRating(value) {
    try {
      setUserRating(value);
      setLoadingUserRating(true);
      await update({
        key: "userRating",
        value,
      });
      toast.success(i18n.t("settings.success"));
    } catch (error) {
      toastError(i18n.t("settings.fail"));
    }
    setLoadingUserRating(false);
  }

  async function handleScheduleType(value) {
    try {
      setScheduleType(value);
      setLoadingScheduleType(true);
      await update({
        key: "scheduleType",
        value,
      });
      setLoadingScheduleType(false);
      toast.success(i18n.t("settings.success"));
    } catch (error) {
      toastError(i18n.t("settings.fail"));
    }
    if (typeof scheduleTypeChanged === "function") {
      scheduleTypeChanged(value);
    }
  }

  async function handleChatBotType(value) {
    try {
      setChatBotType(value);
      await update({
        key: "chatBotType",
        value,
      });
      toast.success(i18n.t("settings.success"));
    } catch (error) {
      toastError(i18n.t("settings.fail"));
    }
    if (typeof scheduleTypeChanged === "function") {
      setChatBotType(value);
    }
  }

  async function handleCallType(value) {
    try {
      setCallType(value);
      await update({
        key: "call",
        value,
      });
      toast.success(i18n.t("settings.success"));
    } catch (error) {
      toastError(i18n.t("settings.fail"));
    }

    if (typeof setCallType === "function") {
      setCallType(value);
    }
  }

  async function handleMsgAutoType(value) {
    try {
      setMsgAutoType(value);
      await update({
        key: "msg_auto",
        value,
      });
      toast.success(i18n.t("settings.success"));
    } catch (error) {
      toastError(i18n.t("settings.fail"));
    }

    if (typeof setMsgAutoType === "function") {
      setMsgAutoType(value);
    }
  }

  return (
    <>
      <Grid spacing={3} container>
        <Grid xs={12} sm={6} md={4} item>
          <FormControl className={classes.selectContainer}>
            <InputLabel id="ratings-label">Avaliações</InputLabel>
            <Select
              labelId="ratings-label"
              value={userRating}
              onChange={async (e) => {
                handleChangeUserRating(e.target.value);
              }}
            >
              <MenuItem value={"disabled"}>Desabilitadas</MenuItem>
              <MenuItem value={"enabled"}>Habilitadas</MenuItem>
            </Select>
            <FormHelperText>
              {loadingUserRating && "Atualizando..."}
            </FormHelperText>
          </FormControl>
        </Grid>
        <Grid xs={12} sm={6} md={4} item>
          <FormControl className={classes.selectContainer}>
            <InputLabel id="schedule-type-label">
              Agendamento de Expediente
            </InputLabel>
            <Select
              labelId="schedule-type-label"
              value={scheduleType}
              onChange={async (e) => {
                handleScheduleType(e.target.value);
              }}
            >
              <MenuItem value={"disabled"}>Desabilitado</MenuItem>
              <MenuItem value={"queue"}>Gerenciamento Por Fila</MenuItem>
              <MenuItem value={"company"}>Gerenciamento Por Empresa</MenuItem>
            </Select>
            <FormHelperText>
              {loadingScheduleType && "Atualizando..."}
            </FormHelperText>
          </FormControl>
        </Grid>
        <Grid xs={12} sm={6} md={4} item>
          <FormControl className={classes.selectContainer}>
            <InputLabel id="schedule-type-label">
              Tipo do Bot
            </InputLabel>
            <Select
              labelId="schedule-type-label"
              value={chatBotType}
              onChange={async (e) => {
                handleChatBotType(e.target.value);
              }}
            >
              <MenuItem value={"text"}>Texto</MenuItem>
              <MenuItem value={"button"}>Botões</MenuItem>
              <MenuItem value={"list"}>Lista</MenuItem>
            </Select>
            <FormHelperText>
              {loadingScheduleType && "Atualizando..."}
            </FormHelperText>
          </FormControl>
        </Grid>
        <Grid xs={12} sm={6} md={4} item>
          <FormControl className={classes.selectContainer}>
            <InputLabel id="call-type-label">
            {i18n.t("settings.call.name")}
            </InputLabel>
            <Select
              labelId="call-type-label"
              value={callType}
              onChange={async (e) => {
                handleCallType(e.target.value);
              }}
            >
              <MenuItem value={"disabled"}>Desabilitada</MenuItem>
              <MenuItem value={"enabled"}>Habilitada</MenuItem>
            </Select>
            <FormHelperText>
              {loadingScheduleType && "Atualizando..."}
            </FormHelperText>
          </FormControl>
        </Grid>
        <Grid xs={12} sm={6} md={4} item>
          <FormControl className={classes.selectContainer}>
            <InputLabel id="msg-auto-type-label">
              Mensagem Automática
            </InputLabel>
            <Select
              labelId="amsg-auto-type-label"
              value={msgAutoType}
              onChange={async (e) => {
                handleMsgAutoType(e.target.value);
              }}
            >
              <MenuItem value={"disabled"}>Desabilitada</MenuItem>
              <MenuItem value={"enabled"}>Habilitada</MenuItem>
            </Select>
            <FormHelperText>
              {loadingScheduleType && "Atualizando..."}
            </FormHelperText>
          </FormControl>
        </Grid>
      </Grid>
    </>
  );
}
