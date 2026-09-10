const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    game: "rolet",
    rooms: rooms.size
  });
});

const rooms = new Map();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const player of room.players) {
    send(player.ws, data);
  }
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function generatePlayerId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 9)
  );
}

function getAlivePlayers(room) {
  return room.players.filter(player => player.alive);
}

function getPublicPlayers(room) {
  return room.players.map(player => ({
    id: player.id,
    name: player.name,
    alive: player.alive,
    isHost: player.id === room.hostId
  }));
}

/*
  تعداد تیرهای واقعی:
  نصف تعداد بازیکنان.

  مثال:
  2 بازیکن = 1 تیر
  4 بازیکن = 2 تیر
  6 بازیکن = 3 تیر
  8 بازیکن = 4 تیر
*/
function getBulletCount(room) {
  return Math.max(
    1,
    Math.floor(room.players.length / 2)
  );
}

/*
  ساخت خشاب جدید برای راند.

  برای هر بازیکن یک خانه در خشاب داریم.
  نصف این خانه‌ها گلوله واقعی هستند.
  محل گلوله‌ها کاملاً تصادفی است.
*/
function reloadGun(room) {
  const totalChambers = Math.max(
    1,
    room.players.length
  );

  const bullets = getBulletCount(room);

  room.bullets = bullets;
  room.remainingBullets = totalChambers;

  room.chambers = Array(
    totalChambers
  ).fill(false);

  let placed = 0;

  while (placed < bullets) {
    const index = Math.floor(
      Math.random() * totalChambers
    );

    if (!room.chambers[index]) {
      room.chambers[index] = true;
      placed++;
    }
  }
}

/*
  انتخاب تصادفی بازیکن زنده برای نوبت بعدی.
*/
function chooseNextTurn(room) {
  const alive = getAlivePlayers(room);

  if (alive.length === 0) {
    room.currentPlayerId = null;
    return;
  }

  const randomIndex = Math.floor(
    Math.random() * alive.length
  );

  room.currentPlayerId =
    alive[randomIndex].id;
}

/*
  اطلاعاتی که برای بازیکنان ارسال می‌شود.
*/
function getRoomState(room) {
  return {
    type: "roomState",

    room: {
      code: room.code,

      started: room.started,

      round: room.round,

      bullets: room.bullets,

      remainingBullets:
        room.remainingBullets,

      currentPlayerId:
        room.currentPlayerId,

      hostId: room.hostId,

      winner: room.winner,

      players:
        getPublicPlayers(room)
    }
  };
}

function broadcastRoomState(room) {
  broadcast(
    room,
    getRoomState(room)
  );
}

/*
  ساخت اتاق.
*/
function createRoom() {
  const room = {
    code: generateRoomCode(),

    players: [],

    hostId: null,

    started: false,

    round: 0,

    bullets: 0,

    remainingBullets: 0,

    chambers: [],

    currentPlayerId: null,

    winner: null,

    finishing: false
  };

  rooms.set(room.code, room);

  return room;
}

/*
  شروع بازی.
*/
function startGame(room) {
  if (room.players.length < 2) {
    return false;
  }

  room.started = true;

  room.finishing = false;

  room.round = 1;

  room.winner = null;

  /*
    همه بازیکنان زنده می‌شوند.
  */
  for (const player of room.players) {
    player.alive = true;
  }

  /*
    خشاب راند اول.
  */
  reloadGun(room);

  /*
    انتخاب بازیکن اول.
  */
  chooseNextTurn(room);

  broadcastRoomState(room);

  broadcast(room, {
    type: "gameStarted"
  });

  return true;
}

/*
  پایان بازی.
*/
function finishGame(room) {
  if (room.finishing) {
    return;
  }

  room.finishing = true;

  const alive =
    getAlivePlayers(room);

  room.started = false;

  room.currentPlayerId = null;

  if (alive.length === 1) {
    room.winner = alive[0].id;
  } else {
    room.winner = null;
  }

  broadcastRoomState(room);

  broadcast(room, {
    type: "gameOver",

    winner:
      alive.length === 1
        ? alive[0].name
        : null
  });

  /*
    بعد از 10 ثانیه همه به لابی برمی‌گردند.
  */
  setTimeout(() => {

    if (!rooms.has(room.code)) {
      return;
    }

    room.finishing = false;

    room.round = 0;

    room.bullets = 0;

    room.remainingBullets = 0;

    room.chambers = [];

    room.currentPlayerId = null;

    room.winner = null;

    room.started = false;

    /*
      برای بازی بعدی همه دوباره زنده هستند.
    */
    for (const player of room.players) {
      player.alive = true;
    }

    broadcastRoomState(room);

    broadcast(room, {
      type: "returnToLobby"
    });

  }, 10000);
}

/*
  شلیک.
*/
function shoot(
  room,
  shooterId,
  targetId
) {

  if (!room.started) {
    return {
      error: "GAME_NOT_STARTED"
    };
  }

  /*
    فقط بازیکنی که نوبتش است
    می‌تواند شلیک کند.
  */
  if (
    room.currentPlayerId !==
    shooterId
  ) {
    return {
      error: "NOT_YOUR_TURN"
    };
  }

  const shooter =
    room.players.find(
      player => player.id === shooterId
    );

  const target =
    room.players.find(
      player => player.id === targetId
    );

  if (!shooter || !target) {
    return {
      error: "PLAYER_NOT_FOUND"
    };
  }

  if (
    !shooter.alive ||
    !target.alive
  ) {
    return {
      error: "PLAYER_DEAD"
    };
  }

  if (room.remainingBullets <= 0) {
    return {
      error: "NO_BULLETS"
    };
  }

  /*
    این قسمت مهم است.

    سرور مشخص می‌کند شلیک
    واقعی بوده یا خالی.

    بازیکن از قبل نمی‌تواند
    نتیجه را بفهمد.
  */
  const chamberIndex =
    room.chambers.length -
    room.remainingBullets;

  const isBullet =
    Boolean(
      room.chambers[chamberIndex]
    );

  /*
    یک خانه از خشاب مصرف شد.
  */
  room.remainingBullets--;

  /*
    اگر تیر واقعی باشد،
    هدف حذف می‌شود.
  */
  if (isBullet) {
    target.alive = false;
  }

  /*
    نتیجه شلیک را برای همه بازیکنان
    ارسال می‌کنیم.

    isBullet = true
    یعنی لیزر قرمز.

    isBullet = false
    یعنی شلیک خالی و لیزر سبز.
  */
  broadcast(room, {
    type: "shot",

    shooterId: shooterId,

    targetId: targetId,

    isBullet: isBullet,

    remainingBullets:
      room.remainingBullets
  });

  /*
    بررسی می‌کنیم چند بازیکن زنده هستند.
  */
  const alive =
    getAlivePlayers(room);

  /*
    اگر فقط یک نفر باقی مانده،
    بازی تمام می‌شود.
  */
  if (alive.length <= 1) {
    finishGame(room);
    return {
      ok: true
    };
  }

  /*
    اگر تمام خانه‌های خشاب مصرف شده،
    راند تمام می‌شود.
  */
  if (room.remainingBullets === 0) {

    room.round++;

    /*
      خشاب کاملاً از نو پر می‌شود.
    */
    reloadGun(room);

    /*
      نوبت جدید.
    */
    chooseNextTurn(room);

    broadcast(room, {
      type: "newRound",

      round: room.round,

      bullets: room.bullets,

      remainingBullets:
        room.remainingBullets,

      currentPlayerId:
        room.currentPlayerId
    });

    broadcastRoomState(room);

    return {
      ok: true
    };
  }

  /*
    اگر هنوز تیر/خانه باقی مانده،
    نوبت بازیکن دیگری می‌شود.
  */
  chooseNextTurn(room);

  broadcast(room, {
    type: "nextTurn",

    currentPlayerId:
      room.currentPlayerId,

    remainingBullets:
      room.remainingBullets
  });

  broadcastRoomState(room);

  return {
    ok: true
  };
}

/*
  اتصال WebSocket بازیکنان.
*/
wss.on("connection", ws => {

  let room = null;

  let player = null;

  send(ws, {
    type: "connected"
  });

  ws.on("message", raw => {

    let message;

    try {
      message =
        JSON.parse(
          raw.toString()
        );
    } catch {
      send(ws, {
        type: "error",
        error: "INVALID_JSON"
      });

      return;
    }

    /*
      ساخت اتاق.
    */
    if (
      message.type ===
      "createRoom"
    ) {

      const name =
        String(
          message.name || ""
        ).trim();

      if (!name) {
        send(ws, {
          type: "error",
          error: "NAME_REQUIRED"
        });

        return;
      }

      if (room) {
        send(ws, {
          type: "error",
          error: "ALREADY_IN_ROOM"
        });

        return;
      }

      room = createRoom();

      player = {
        id:
          generatePlayerId(),

        name:
          name.slice(0, 20),

        alive: true,

        ws: ws
      };

      room.players.push(player);

      room.hostId =
        player.id;

      send(ws, {
        type: "roomCreated",

        roomCode:
          room.code,

        playerId:
          player.id
      });

      broadcastRoomState(room);

      return;
    }

    /*
      ورود به اتاق.
    */
    if (
      message.type ===
      "joinRoom"
    ) {

      const name =
        String(
          message.name || ""
        ).trim();

      const roomCode =
        String(
          message.code || ""
        )
        .trim()
        .toUpperCase();

      if (!name) {
        send(ws, {
          type: "error",
          error: "NAME_REQUIRED"
        });

        return;
      }

      if (roomCode.length !== 6) {
        send(ws, {
          type: "error",
          error: "ROOM_CODE_REQUIRED"
        });

        return;
      }

      room =
        rooms.get(roomCode);

      if (!room) {
        send(ws, {
          type: "error",
          error: "ROOM_NOT_FOUND"
        });

        return;
      }

      if (room.started) {
        send(ws, {
          type: "error",
          error:
            "GAME_ALREADY_STARTED"
        });

        return;
      }

      /*
        حداکثر 12 بازیکن.
      */
      if (
        room.players.length >= 12
      ) {
        send(ws, {
          type: "error",
          error: "ROOM_FULL"
        });

        return;
      }

      player = {
        id:
          generatePlayerId(),

        name:
          name.slice(0, 20),

        alive: true,

        ws: ws
      };

      room.players.push(player);

      send(ws, {
        type: "roomJoined",

        roomCode:
          room.code,

        playerId:
          player.id
      });

      broadcastRoomState(room);

      return;
    }

    /*
      شروع بازی توسط میزبان.
    */
    if (
      message.type ===
      "startGame"
    ) {

      if (!room || !player) {
        return;
      }

      if (
        player.id !==
        room.hostId
      ) {

        send(ws, {
          type: "error",

          error:
            "ONLY_HOST_CAN_START"
        });

        return;
      }

      if (!startGame(room)) {

        send(ws, {
          type: "error",

          error:
            "NOT_ENOUGH_PLAYERS"
        });

        return;
      }

      return;
    }

    /*
      شلیک.
    */
    if (
      message.type ===
      "shoot"
    ) {

      if (!room || !player) {
        return;
      }

      const result =
        shoot(
          room,

          player.id,

          String(
            message.targetId || ""
          )
        );

      if (result.error) {

        send(ws, {
          type: "error",

          error:
            result.error
        });
      }

      return;
    }

    /*
      Ping برای زنده نگه داشتن اتصال.
    */
    if (
      message.type ===
      "ping"
    ) {

      send(ws, {
        type: "pong"
      });

      return;
    }
  });

  /*
    وقتی بازیکن از بازی خارج شد.
  */
  ws.on("close", () => {

    if (!room || !player) {
      return;
    }

    const index =
      room.players.findIndex(
        p => p.id === player.id
      );

    if (index >= 0) {
      room.players.splice(
        index,
        1
      );
    }

    /*
      اگر میزبان خارج شد،
      نفر بعدی میزبان می‌شود.
    */
    if (
      room.hostId ===
      player.id
    ) {

      if (room.players.length) {

        room.hostId =
          room.players[0].id;

      } else {

        rooms.delete(
          room.code
        );

        return;
      }
    }

    /*
      اگر بازی در حال اجرا بود،
      وضعیت بازیکنان بررسی می‌شود.
    */
    if (room.started) {

      if (
        getAlivePlayers(room)
          .length <= 1
      ) {

        finishGame(room);

        return;
      }

      /*
        اگر نوبت بازیکنی بود که
        خارج شد، نوبت جدید انتخاب می‌شود.
      */
      if (
        room.currentPlayerId ===
        player.id
      ) {

        chooseNextTurn(room);
      }
    }

    broadcastRoomState(room);
  });
});

/*
  اجرای سرور.
*/
server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `ROLET server listening on port ${PORT}`
    );

  }
);
