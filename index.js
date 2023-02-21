// @version 0.0.6 新增 429 限频场景下的兼容
import lark from "@larksuiteoapi/node-sdk";
import express from "express";
import axios from "axios";
import "isomorphic-fetch";
import path from "path";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
const __dirname = path.resolve();
const dbName = path.join(__dirname, "data.db");
const tableName = "t_chatgpt_feishu_event";
const app = express();
dotenv.config();

const port = process.env.PROT || 9000;
// 如果你不想配置环境变量，或环境变量不生效，则可以把结果填写在每一行最后的 "" 内部
const FEISHU_APP_ID = process.env.APPID || ""; // 飞书的应用 ID
const FEISHU_APP_SECRET = process.env.SECRET || ""; // 飞书的应用的 Secret
const FEISHU_BOTNAME = process.env.BOTNAME || ""; // 飞书机器人的名字
const OPENAI_KEY = process.env.KEY || ""; // OpenAI 的 Key
const OPENAI_MODEL = process.env.MODEL || "text-davinci-003"; // 使用的模型
let api;
(async () => {
  const { ChatGPTAPI } = await import("chatgpt");
  api = new ChatGPTAPI({
    apiKey: OPENAI_KEY,
    debug: false,
  });
})();
const client = new lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  disableTokenCache: false,
});

// 日志辅助函数，请贡献者使用此函数打印关键日志
function logger(param) {
  console.warn(`[CF]`, param);
}

const delay = (ms) => {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), ms);
  });
};

// 回复消息
async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: "text",
      },
    });
  } catch (e) {
    logger("send message to feishu error", e, messageId, content);
  }
}

const conversationPool = {};
const retryPool = {};
// 通过 OpenAI API 获取回复
async function getOpenAIReply(talkerId, content) {
  const prompt = content.trim();
  retryPool[talkerId] = 1;
  try {
    const conversation = conversationPool[talkerId];
    const response = await api.sendMessage(prompt, {
      conversationId: conversation?.conversationId,
      parentMessageId: conversation?.messageId,
      timeoutMs: 2 * 60 * 1000,
    });

    conversationPool[talkerId] = {
      messageId: response.id,
      conversationId: response.conversationId,
    };
    // 去除多余的换行
    return response.text.replace("\n\n", "");
  } catch (e) {
    if (retryPool[talkerId]) {
      delete retryPool[talkerId];
      console.log("retry...", e);
      await delay(1000);
      return getOpenAIReply(talkerId, content);
    }
    return "请求失败";
  }
}

// 自检函数
function doctor() {
  if (FEISHU_APP_ID === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的 AppID，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP id, please check & re-Deploy & call again",
      },
    };
  }
  if (!FEISHU_APP_ID.startsWith("cli_")) {
    return {
      code: 1,
      message: {
        zh_CN:
          "你配置的飞书应用的 AppID 是错误的，请检查后重试。飞书应用的 APPID 以 cli_ 开头。",
        en_US:
          "Your FeiShu App ID is Wrong, Please Check and call again. FeiShu APPID must Start with cli",
      },
    };
  }
  if (FEISHU_APP_SECRET === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的 Secret，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP Secret, please check & re-Deploy & call again",
      },
    };
  }

  if (FEISHU_BOTNAME === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置飞书应用的名称，请检查 & 部署后重试",
        en_US:
          "Here is no FeiSHu APP Name, please check & re-Deploy & call again",
      },
    };
  }

  if (OPENAI_KEY === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置 OpenAI 的 Key，请检查 & 部署后重试",
        en_US: "Here is no OpenAI Key, please check & re-Deploy & call again",
      },
    };
  }

  if (!OPENAI_KEY.startsWith("sk-")) {
    return {
      code: 1,
      message: {
        zh_CN:
          "你配置的 OpenAI Key 是错误的，请检查后重试。飞书应用的 APPID 以 cli_ 开头。",
        en_US:
          "Your OpenAI Key is Wrong, Please Check and call again. FeiShu APPID must Start with cli",
      },
    };
  }
  return {
    code: 0,
    message: {
      zh_CN:
        "✅ 配置成功，接下来你可以在飞书应用当中使用机器人来完成你的工作。",
      en_US:
        "✅ Configuration is correct, you can use this bot in your FeiShu App",
    },
    meta: {
      FEISHU_APP_ID,
      OPENAI_MODEL,
      FEISHU_BOTNAME,
    },
  };
}

app.use(bodyParser.json());

app.get("/", async (req, resp) => {
  const result = doctor();
  resp.json(result);
});

// 检查是否存在回调事件
const checkHasEvent = async (eventId) => {
  const db = await open({
    filename: dbName,
    driver: sqlite3.cached.Database,
  });

  try {
    // 创建表格
    const createSql = `
    CREATE TABLE if not exists ${tableName}(
    id INTEGER PRIMARY KEY,
    event_id constCHAR (40) NOT NULL)`;

    await db.run(createSql);
    const rows = await db.all(
      `SELECT count(*) as count FROM ${tableName} WHERE event_id = '${eventId}'`
    );
    console.log("events count:", rows[0]);
    if (rows[0].count > 0) {
      return true;
    }
    await db.run(`INSERT INTO ${tableName} (event_id) VALUES (?)`, [eventId]);
  } catch (error) {
    logger(error);
  }
  return false;
};

app.post("/", async (req, resp, context) => {
  let params = req.body;
  if (typeof req.params !== "object") {
    const sJson = JSON.stringify(req.body);
    const jsonData = JSON.parse(sJson);
    const buf = new Buffer.from(jsonData);
    const data = buf.toString();
    if (data) {
      const json = JSON.parse(data);
      params = json;
      console.log("json", json);
    } else {
      params = {};
    }
  }

  const callback = (msg) => {
    resp.setHeader("Content-Type", "application/json");
    msg.challenge = params.challenge;
    resp.json(msg);
  };

  // 如果存在 encrypt 则说明配置了 encrypt key
  if (params.encrypt) {
    logger("user enable encrypt key");
    callback({
      code: 1,
      message: {
        zh_CN: "你配置了 Encrypt Key，请关闭该功能。",
        en_US: "You have open Encrypt Key Feature, please close it.",
      },
    });
    return;
  }
  // 处理飞书开放平台的服务端校验
  if (params.type === "url_verification") {
    logger("deal url_verification");
    callback({
      challenge: params.challenge,
    });
    return;
  }
  // 自检查逻辑
  if (!params.hasOwnProperty("header") || context.trigger === "DEBUG") {
    logger("enter doctor");
    callback(doctor());
    return;
  }
  // 处理飞书开放平台的事件回调
  if (params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatType = params.event.message.chat_type;
    const chatId = params.event.message.chat_id; // 用户群组ID'
    const senderId = params.event.sender.sender_id.union_id;
    const talkerId = chatType === "p2p" ? senderId : chatId;
    const hasEvent = await checkHasEvent(eventId);
    if (hasEvent) {
      callback({ code: 1 });
      return;
    }

    const replyMsg = async (talkerId, question) => {
      console.log("question:", question);
      const chatResponse = await getOpenAIReply(talkerId, question);
      console.log("chatResponse:", chatResponse);
      await reply(messageId, chatResponse);
    };

    // 私聊直接回复
    if (chatType === "p2p") {
      // 不是文本消息，不处理
      if (params.event.message.message_type != "text") {
        await reply(messageId, "暂不支持其他类型的提问");
        logger("skip and reply not support");
        callback({ code: 0 });
        return;
      }
      // 是文本消息，直接回复
      const userInput = JSON.parse(params.event.message.content);
      const question = userInput.text.replace("@_user_1", "");

      replyMsg(talkerId, question);
      callback({ code: 0 });
      return;
    }

    // 群聊，需要 @ 机器人
    if (chatType === "group") {
      // 这是日常群沟通，不用管
      if (
        !params.event.message.mentions ||
        params.event.message.mentions.length === 0
      ) {
        logger("not process message without mention");
        callback({ code: 0 });
        return;
      }
      // 没有 mention 机器人，则退出。
      if (params.event.message.mentions[0].name != FEISHU_BOTNAME) {
        logger("bot name not equal first mention name ");
        callback({ code: 0 });
        return;
      }
      const userInput = JSON.parse(params.event.message.content);
      const question = userInput.text.replace("@_user_1", "");
      replyMsg(talkerId, question);
      callback({ code: 0 });
      return;
    }
  }

  logger("return without other log");
  callback({ code: 2 });
  return;
});

app.listen(port, () => {
  console.log(`Chat app listening on port ${port}`);
});
