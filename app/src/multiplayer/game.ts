/**
 * Multiplayer game controller.
 *
 * Reuses the core game logic (src/game/) and 3D rendering (src/scene/)
 * but manages state across multiple players via the network layer.
 */

import { BLANK, letterValue } from "../game/letters";
import type { Placed } from "../game/letters";
import { DIFFICULTY_LABEL } from "../game/bot";
import type { Difficulty } from "../game/bot";
import {
  HP_START,
  outcomeOf,
  rackFor,
} from "../game/duel";
import type { DuelState, RoundResult, Side } from "../game/duel";
import { buildStudyCard } from "../game/coach";
import { isWord, loadDictionary, solve, wordCount } from "../game/words";
import { readBoard, saveScore, signInUrl, whoAmI } from "../startng";
import type { StartNgPlayer } from "../startng";
import { createArena } from "../scene/arena";
import { FABRIC_BLURB, FABRIC_LABEL, fabricSwatch } from "../scene/cloth";
import type { Fabric } from "../scene/cloth";
import { Table, type BuiltTile } from "../scene/table";
import { network, type LobbyState, type RoundStartData, type WordSubmission, type RoundResultData } from "./network";

/** Only this clock is ranked: more time is an easier game. */
const RANKED_MS = 20000;

interface Clock {
  name: string;
  blurb: string;
  ms: number;
}

const CLOCKS: Clock[] = [
  { name: "No wahala", blurb: "60 seconds", ms: 60000 },
  { name: "Small wahala", blurb: "40 seconds", ms: 40000 },
  { name: "Serious wahala", blurb: "20 seconds", ms: RANKED_MS },
];

const TIERS: Difficulty[] = ["rookie", "sharp", "pro"];
const FABRICS: Fabric[] = ["ankara", "adire"];
const TIER_BLURB: Record<Difficulty, string> = {
  rookie: "weak words",
  sharp: "strong words",
  pro: "the best word",
};

type Screen = "boot" | "title" | "lobby" | "match" | "result";
type Phase = "play" | "clash" | "done";
type MultiplayerRole = "host" | "client";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const screens: Record<Screen, HTMLElement> = {
  boot: el("boot"),
  title: el("title"),
  lobby: el("lobby"),
  match: el("match"),
  result: el("result"),
};

const arena = createArena(el("stage"));
const table = new Table(arena, {
  onRackTap: (slot) => tapTile(slot),
  onWordTap: (index) => untap(index),
});

let difficulty: Difficulty = "sharp";
let fabric: Fabric = "ankara";
let clockMs = RANKED_MS;
let matchRanked = true;

let duel: DuelState | null = null;
let rack: string[] = [];
let built: BuiltTile[] = [];
let used: boolean[] = [];
let phase: Phase = "play";
let noticeText = "";
let roundNo = 1;
let roundOwner: Side = "you";
let timerEnd = 0;
let rafId = 0;
let pendingState: DuelState | null = null;

let myPlayerId: number | null = null;
let mySeat = -1;
let role: MultiplayerRole = "client";
let lobbyState: LobbyState | null = null;
let pendingSubmissions: Map<number, WordSubmission> = new Map();

let me: StartNgPlayer | null = null;

const CAREER_KEY = "pick-me.career";
const ESCAPES: Record<string, string> = {
  "&": "&",
  "<": "<",
  ">": ">",
  '"': String.fromCharCode(34),
  "'": "'",
};

interface Career {
  proWins: number;
  bestWord: number;
  bestMargin: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

function loadCareer(): Career {
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Career>;
      return {
        proWins: Math.max(0, saved.proWins ?? 0),
        bestWord: Math.max(0, saved.bestWord ?? 0),
        bestMargin: Math.max(0, saved.bestMargin ?? 0),
      };
    }
  } catch {
    /* a corrupt value is not worth failing over */
  }
  return { proWins: 0, bestWord: 0, bestMargin: 0 };
}

function storeCareer(career: Career): void {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    /* private mode, no storage */
  }
}

function recordRun(state: DuelState, outcome: string): Career {
  const career = loadCareer();
  if (!matchRanked) return career;
  if (outcome === "you" && difficulty === "pro") career.proWins += 1;
  for (const round of state.history) {
    career.bestWord = Math.max(career.bestWord, round.yourScore);
    if (round.winner === "you") {
      career.bestMargin = Math.max(career.bestMargin, round.damage);
    }
  }
  storeCareer(career);
  return career;
}

function renderPlayerCard(user: StartNgPlayer | null, guest: StartNgPlayer | null): void {
  const shown = user ?? guest;
  if (!shown) return;
  const face = el<HTMLImageElement>("player-face");
  face.onerror = () => { face.hidden = true; };
  if (shown.face) {
    face.src = shown.face;
    face.hidden = false;
  } else {
    face.hidden = true;
  }
  el("player-name").textContent = shown.name;
  el("player-account").textContent = user?.account ? `@${user.account}` : "Not signed in";
  const button = el<HTMLButtonElement>("player-sign-in");
  button.hidden = !!user;
  button.onclick = () => { location.href = signInUrl(); };
  el("player-card").hidden = false;
}

function show(screen: Screen): void {
  (Object.keys(screens) as Screen[]).forEach((key) => {
    screens[key].classList.toggle("hidden", key !== screen);
  });
}

function buildTitle(): void {
  const diffRow = el("diff-row");
  diffRow.innerHTML = "";
  for (const tier of TIERS) {
    const button = document.createElement("button");
    button.className = "pick-option" + (tier === difficulty ? " on" : "");
    button.innerHTML = `<b>${DIFFICULTY_LABEL[tier]}</b><span>${TIER_BLURB[tier]}</span>`;
    button.addEventListener("click", () => {
      difficulty = tier;
      buildTitle();
    });
    diffRow.appendChild(button);
  }

  const clockRow = el("clock-row");
  clockRow.innerHTML = "";
  for (const clock of CLOCKS) {
    const button = document.createElement("button");
    button.className = "pick-option" + (clock.ms === clockMs ? " on" : "");
    button.innerHTML = `<b>${clock.name}</b><span>${clock.blurb}</span>`;
    button.addEventListener("click", () => {
      clockMs = clock.ms;
      buildTitle();
    });
    clockRow.appendChild(button);
  }

  const fabricRow = el("fabric-row");
  fabricRow.innerHTML = "";
  for (const kind of FABRICS) {
    const button = document.createElement("button");
    button.className = "pick-option with-swatch" + (kind === fabric ? " on" : "");
    const swatch = fabricSwatch(kind, 30);
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    button.appendChild(swatch);
    const label = document.createElement("div");
    label.innerHTML = `<b>${FABRIC_LABEL[kind]}</b><span>${FABRIC_BLURB[kind]}</span>`;
    button.appendChild(label);
    button.addEventListener("click", () => {
      fabric = kind;
      arena.setFabric(kind);
      buildTitle();
    });
    fabricRow.appendChild(button);
  }
}

async function refreshPlayer(): Promise<void> {
  const reply = await whoAmI();
  if (!reply) return;
  me = reply.user ?? null;
  renderPlayerCard(reply.user, reply.guest);
}

async function initMultiplayer(): Promise<void> {
  const ticket = await network.getTicket();
  if (!ticket) {
    el("boot-msg").textContent = "Multiplayer requires sign-in on start.ng";
    return;
  }
  await network.connect(ticket);
  myPlayerId = network.getPlayerId();
  setupNetworkHandlers();
}

function setupNetworkHandlers(): void {
  network.on("lobby_state", (msg) => {
    lobbyState = msg.payload;
    updateLobbyUI();
  });

  network.on("player_join", (msg) => {
    if (lobbyState) {
      lobbyState.players.push(msg.payload);
      updateLobbyUI();
    }
  });

  network.on("player_leave", (msg) => {
    if (lobbyState) {
      lobbyState.players = lobbyState.players.filter(p => p.id !== msg.payload.playerId);
      updateLobbyUI();
    }
  });

  network.on("player_ready", (msg) => {
    if (lobbyState) {
      const player = lobbyState.players.find(p => p.id === msg.payload.playerId);
      if (player) {
        player.ready = msg.payload.ready;
        updateLobbyUI();
      }
    }
  });

  network.on("game_start", () => {
    if (role === "host") {
      startMatchFromLobby();
    }
  });

  network.on("round_start", (msg) => {
    const data: RoundStartData = msg.payload;
    startRound(data.seed, data.rack, data.clockMs, data.round, data.turnOwner);
  });

  network.on("word_submit", (msg) => {
    if (role === "host") {
      const submission: WordSubmission = msg.payload;
      pendingSubmissions.set(submission.playerId, submission);
      checkAllSubmitted();
    }
  });

  network.on("round_result", (msg) => {
    const data: RoundResultData = msg.payload;
    applyRoundResult(data);
  });

  network.on("game_over", (msg) => {
    showResult(msg.payload);
  });

  network.on("error", (msg) => {
    setNotice(msg.payload.message);
  });
}

function updateLobbyUI(): void {
  if (!lobbyState) return;
  el("lobby-code").textContent = lobbyState.code;
  el("lobby").hidden = false;

  const seatsEl = el("lobby-seats");
  seatsEl.innerHTML = "";
  for (const player of lobbyState.players) {
    const row = document.createElement("div");
    row.className = "lobby-row";
    const isMe = player.id === myPlayerId;
    const isHost = player.id === lobbyState.hostId;
    row.innerHTML = `
      <span class="lobby-seat">P${player.seat + 1}</span>
      <span class="lobby-name">${escapeHtml(player.name)}${isMe ? " (you)" : ""}${isHost ? " \u2605" : ""}</span>
      <span class="lobby-status">${player.ready ? "Ready" : "Waiting"}</span>
    `;
    seatsEl.appendChild(row);
  }

  const allReady = lobbyState.players.length >= 2 && lobbyState.players.every(p => p.ready);
  const canStart = role === "host" && allReady && !lobbyState.gameStarted;
  const createBtn = el<HTMLButtonElement>("btn-create");
  createBtn.textContent = canStart ? "Start Game" : "Create Game";
  createBtn.disabled = !canStart;

  if (lobbyState.gameStarted) {
    el("lobby-waiting").textContent = "Game starting...";
  } else if (allReady && role === "host") {
    el("lobby-waiting").textContent = "All ready - press Start Game";
  } else {
    el("lobby-waiting").textContent = `Waiting for players... (${lobbyState.players.length}/${lobbyState.maxPlayers})`;
  }
}

async function createLobby(): Promise<void> {
  role = "host";
  el("title").hidden = true;
  el("lobby").hidden = false;
  const createBtn = el<HTMLButtonElement>("btn-create");
  createBtn.textContent = "Creating...";
  createBtn.disabled = true;
  network.createLobby(4, clockMs);
}

function joinLobby(): void {
  const code = prompt("Enter lobby code:");
  if (!code) return;
  role = "client";
  el("title").hidden = true;
  el("lobby").hidden = false;
  network.joinLobby(code.trim().toUpperCase());
}

function startMatchFromLobby(): void {
  if (!lobbyState || role !== "host") return;
  lobbyState.gameStarted = true;
  updateLobbyUI();

  const seed = Math.floor(Math.random() * 4294967296);
  const rackData = rackFor(seed, 1);

  // Send round start to all players
  const roundData: RoundStartData = {
    seed,
    rack: rackData,
    clockMs,
    round: 1,
    turnOwner: 0, // Host goes first
  };

  network.send({ type: "round_start", payload: roundData });
  startRound(seed, rackData, clockMs, 1, 0);
}

function startRound(_seed: number, rackData: string[], _clockMsParam: number, round: number, turnOwner: number): void {
  if (!duel) return;
  if (duel.over) {
    showResult();
    return;
  }

  table.reset();
  rack = rackData;
  built = [];
  used = rack.map(() => false);
  phase = "play";
  roundNo = round;
  roundOwner = turnOwner === mySeat ? "you" : "them";

  table.setRack(rack, used);
  table.setTheirRack(rack); // All players have same rack
  table.setWord(built);

  el("verdict").innerHTML = "";
  renderScores(null);
  el("next-row").classList.add("hidden");

  renderHud();
  renderRound();
  renderWall();
  setNotice("");
  setControls(true);
  beginTimer();
}

function beginTimer(): void {
  timerEnd = performance.now() + clockMs;
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (phase !== "play") return;
    const left = Math.max(0, timerEnd - performance.now());
    const fill = el("timer-fill");
    fill.style.width = `${(left / clockMs) * 100}%`;
    fill.classList.toggle("low", left < 5000);
    if (left <= 0) {
      timeUp();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function timeUp(): void {
  if (phase !== "play") return;
  const word = built.map((item) => item.letter).join("");
  if (word.length >= 2 && isWord(word)) {
    setNotice("Out of time - your word counts.");
    submitWord(false);
    return;
  }
  setNotice(
    word.length >= 2
      ? `Out of time - ${word} is not in the word list.`
      : "Out of time.",
  );
  submitWord(true);
}

function submitWord(pass: boolean): void {
  if (phase !== "play" || !duel) return;

  const word = built.map((item) => item.letter).join("");
  if (!pass) {
    if (word.length < 2) {
      setNotice("Two letters, minimum.");
      return;
    }
    if (!isWord(word)) {
      setNotice(`${word} is not in the word list.`);
      return;
    }
  }

  phase = "clash";
  cancelAnimationFrame(rafId);
  setControls(false);
  setNotice("");

  const placements = built.map((item) => item.slot);
  const submission: WordSubmission = {
    playerId: myPlayerId!,
    word: pass ? "" : word,
    placements,
  };

  if (role === "host") {
    pendingSubmissions.set(myPlayerId!, submission);
    checkAllSubmitted();
  } else {
    network.submitWord(submission.word, submission.placements);
  }
}

function checkAllSubmitted(): void {
  if (!lobbyState) return;
  const expected = lobbyState.players.length;
  if (pendingSubmissions.size >= expected) {
    resolveMultiplayerRound();
  }
}

function resolveMultiplayerRound(): void {
  if (!duel || !lobbyState) return;

  // Collect all submissions
  const submissions: WordSubmission[] = [];
  for (const player of lobbyState.players) {
    const sub = pendingSubmissions.get(player.id);
    if (sub) {
      submissions.push(sub);
    } else {
      // Player didn't submit - treat as pass
      submissions.push({ playerId: player.id, word: "", placements: [] });
    }
  }

  // Resolve using the shared rack
  const scores = new Map<number, number>();
  const words = new Map<number, string>();

  for (const sub of submissions) {
    const placed: Placed[] = sub.word.length > 0
      ? sub.placements.map((slot, idx) => ({ letter: sub.word[idx], tile: rack[slot] }))
      : [];
    words.set(sub.playerId, sub.word);

    // Score this word
    let score = 0;
    for (const p of placed) {
      score += letterValue(p.letter);
    }
    if (placed.length === 7) score += 50;
    scores.set(sub.playerId, score);
  }

  // Determine winner (highest score, tie goes to turn owner)
  let winnerId = -1;
  let bestScore = -1;
  for (const [pid, score] of scores) {
    if (score > bestScore || (score === bestScore && pid === (roundOwner === "you" ? myPlayerId : lobbyState?.players.find(p => p.seat === 0)?.id))) {
      bestScore = score;
      winnerId = pid;
    }
  }

  // Calculate damage
  const damage = new Map<number, number>();
  for (const [pid, score] of scores) {
    if (pid !== winnerId) {
      const dmg = Math.max(3, bestScore - score);
      damage.set(pid, dmg);
      if (duel) {
        if (pid === myPlayerId) duel.hpYou = Math.max(0, duel.hpYou - dmg);
        else duel.hpThem = Math.max(0, duel.hpThem - dmg);
      }
    }
  }

  // Best word from rack
  const best = solve(rack)[0] ?? null;

  const resultData: RoundResultData = {
    words: new Map(),
    winner: winnerId,
    damage,
    bestWord: best ? { word: best.word, score: best.score } : null,
  };

  for (const [pid, word] of words) {
    const score = scores.get(pid) || 0;
    const bingo = word.length === 7;
    resultData.words.set(pid, { word, score, bingo });
  }

  // Apply locally for host
  if (role === "host") {
    applyRoundResult(resultData);
  }

  // Broadcast to all
  network.send({ type: "round_result", payload: resultData });
  pendingSubmissions.clear();
}

function applyRoundResult(data: RoundResultData): void {
  // Find my result
  const myResult = data.words.get(myPlayerId!);
  const myScore = myResult?.score || 0;
  const myWord = myResult?.word || "";
  const myBingo = myResult?.bingo || false;

  // Find opponent result (simplified for 2 players, extend for 4)
  let theirScore = 0;
  let theirWord = "";
  let theirBingo = false;
  for (const [pid, r] of data.words) {
    if (pid !== myPlayerId) {
      theirScore = r.score;
      theirWord = r.word;
      theirBingo = r.bingo;
      break;
    }
  }

  const winner = data.winner === myPlayerId ? "you" : "them";
  const dmg = data.damage.get(myPlayerId!) || 0;

  const result: RoundResult = {
    index: roundNo,
    rack: rack.slice(),
    owner: roundOwner,
    yourWord: myWord,
    yourScore: myScore,
    theirWord: theirWord,
    theirScore: theirScore,
    winner,
    damage: dmg,
    best: data.bestWord,
    youBingo: myBingo,
    themBingo: theirBingo,
  };

  // Update duel state
  if (duel) {
    duel.history.push({
      index: roundNo,
      rack: rack.slice(),
      owner: roundOwner,
      yourWord: myWord,
      yourScore: myScore,
      theirWord: theirWord,
      theirScore: theirScore,
      winner,
      damage: dmg,
      best: data.bestWord,
      youBingo: myBingo,
      themBingo: theirBingo,
    });
  }

  landImpact(result);
}

function landImpact(result: RoundResult): void {
  duel = pendingState;
  pendingState = null;
  phase = "done";

  renderScores(result);
  renderHud();
  renderVerdict(result);
  renderWall();
}

function nextRound(): void {
  if (!duel) return;
  if (duel.over) {
    showResult();
    return;
  }
  if (role === "host") {
    const seed = Math.floor(Math.random() * 4294967296);
    const nextRoundNo = roundNo + 1;
    const rackData = rackFor(seed, nextRoundNo);
    const turnOwner = (roundNo % 2 === 0) ? mySeat : (mySeat === 0 ? 1 : 0);

    const roundData: RoundStartData = {
      seed,
      rack: rackData,
      clockMs,
      round: nextRoundNo,
      turnOwner,
    };

    network.send({ type: "round_start", payload: roundData });
    startRound(seed, rackData, clockMs, nextRoundNo, turnOwner);
  }
}

function setControls(on: boolean): void {
  for (const id of ["btn-shuffle", "btn-clear", "btn-pass", "btn-play"]) {
    const btn = el<HTMLButtonElement>(id);
    btn.disabled = !on;
  }
}

function setNotice(text: string): void {
  noticeText = text;
  const node = el("readout");
  node.classList.remove("shake");
  if (text) {
    void node.offsetWidth;
    node.classList.add("shake");
  }
  renderReadout();
}

function renderReadout(): void {
  const host = el("readout");
  if (noticeText) {
    host.textContent = noticeText;
    host.className = "readout bad";
    return;
  }
  const word = built.map((item) => item.letter).join("");
  if (phase !== "play" || word.length === 0) {
    host.textContent = "";
    host.className = "readout";
    return;
  }
  if (word.length < 2) {
    host.textContent = `${word} - two letters minimum`;
    host.className = "readout bad";
    return;
  }
  if (!isWord(word)) {
    host.textContent = `${word} - not in the word list`;
    host.className = "readout bad";
    return;
  }
  host.textContent = `${word} \u2713`;
  host.className = "readout ok";
}

function renderScores(result: RoundResult | null): void {
  const you = el("score-you");
  const them = el("score-them");
  if (!result) {
    el("your-score").textContent = "";
    el("their-score").textContent = "";
    you.className = "score";
    them.className = "score";
    return;
  }
  el("your-score").textContent = String(result.yourScore);
  el("their-score").textContent = String(result.theirScore);
  you.className = `score ${result.winner === "you" ? "win" : "lose"}`;
  them.className = `score ${result.winner === "them" ? "win" : "lose"}`;
}

function renderVerdict(result: RoundResult): void {
  const youWon = result.winner === "you";
  const draw = result.yourScore === result.theirScore;

  const head = draw
    ? "DEAD HEAT - THE TURN TAKES IT"
    : youWon
      ? "YOUR WORD STANDS"
      : "THEIR WORD STANDS";

  const facts: string[] = [
    `<span class="fact">${result.damage} damage to ${youWon ? "them" : "you"}</span>`,
  ];
  if (result.youBingo) facts.push(`<span class="fact">bingo - all seven - +50</span>`);
  if (result.themBingo) facts.push(`<span class="fact">they bingoed</span>`);
  if (result.best && result.yourScore < result.best.score) {
    facts.push(
      `<span class="fact">best play <b>${result.best.word.toUpperCase()}</b> ` +
        `${result.best.score}</span>`,
    );
  }

  el("verdict").innerHTML =
    `<div class="verdict-line ${youWon ? "good" : "bad"}">${head}</div>` +
    `<div class="facts">${facts.join("<i>\u00b7</i>")}</div>`;
}

function renderWall(): void {
  const host = el("wall");
  if (!duel) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = duel.history
    .slice(-8)
    .map((round) => {
      const youWon = round.winner === "you";
      return (
        `<div class="chip ${youWon ? "good" : "bad"}">` +
        `<span class="chip-r">R${round.index}</span>` +
        `<span class="chip-y">${round.yourWord.toUpperCase() || "\u2014"} ${round.yourScore}</span>` +
        `<span class="chip-x">${round.theirWord.toUpperCase() || "\u2014"} ${round.theirScore}</span>` +
        `</div>`
      );
    })
    .join("");
}

function renderHud(): void {
  if (!duel) return;
  el("hp-you").style.width = `${(Math.max(0, duel.hpYou) / HP_START) * 100}%`;
  el("hp-them").style.width = `${(Math.max(0, duel.hpThem) / HP_START) * 100}%`;
  el("round-label").textContent = `ROUND ${roundNo} \u00b7 ${duel.label}`;
  const owner = el("owner-label");
  owner.textContent = roundOwner === "you" ? "TIES GO TO YOU" : "TIES GO TO THEM";
  owner.className = roundOwner === "you" ? "you" : "them";
}

function renderRound(): void {
  el("them-name").textContent = DIFFICULTY_LABEL[difficulty];
}

/* -------------------------------------------------------------- controls --- */

function tapTile(slot: number): void {
  if (phase !== "play" || used[slot]) return;
  if (rack[slot] === BLANK) {
    openBlankPicker(slot);
    return;
  }
  noticeText = "";
  built.push({ slot, letter: rack[slot] });
  used[slot] = true;
  table.setRack(rack, used);
  table.setWord(built);
  renderReadout();
}

function tapBlank(slot: number, letter: string): void {
  if (phase !== "play" || used[slot]) return;
  noticeText = "";
  built.push({ slot, letter });
  used[slot] = true;
  table.setRack(rack, used);
  table.setWord(built);
  renderReadout();
}

function untap(index: number): void {
  if (phase !== "play") return;
  const item = built[index];
  if (!item) return;
  noticeText = "";
  used[item.slot] = false;
  built.splice(index, 1);
  table.setRack(rack, used);
  table.setWord(built);
  renderReadout();
}

function clearWord(): void {
  if (phase !== "play") return;
  noticeText = "";
  built = [];
  used = rack.map(() => false);
  table.setRack(rack, used);
  table.setWord(built);
  renderReadout();
}

function shuffleRack(): void {
  if (phase !== "play") return;
  noticeText = "";
  const slots = rack
    .map((_, index) => index)
    .filter((index) => !used[index] && rack[index] !== BLANK);
  const letters = slots.map((index) => rack[index]);
  for (let i = letters.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = letters[i];
    letters[i] = letters[j];
    letters[j] = swap;
  }
  slots.forEach((slot, index) => {
    rack[slot] = letters[index];
  });
  table.setRack(rack, used);
  renderReadout();
}

function openBlankPicker(slot: number): void {
  const host = el("blank-picker");
  host.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "picker-grid";
  for (let code = 65; code < 91; code += 1) {
    const letter = String.fromCharCode(code);
    const button = document.createElement("button");
    button.className = "tile rack-tile";
    button.innerHTML = `<span class="tl">${letter}</span><span class="tv">${letterValue(letter)}</span>`;
    button.addEventListener("click", () => {
      host.classList.add("hidden");
      tapBlank(slot, letter);
    });
    grid.appendChild(button);
  }

  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => host.classList.add("hidden"));

  host.appendChild(grid);
  host.appendChild(cancel);
  host.classList.remove("hidden");
}

function onKey(event: KeyboardEvent): void {
  if (phase !== "play" || !duel) return;
  if (screens.match.classList.contains("hidden")) return;
  if (!el("blank-picker").classList.contains("hidden")) return;

  if (event.key === "Enter") {
    submitWord(false);
    return;
  }
  if (event.key === "Backspace") {
    event.preventDefault();
    if (built.length > 0) untap(built.length - 1);
    return;
  }
  if (event.key === "Escape") {
    clearWord();
    return;
  }
  if (!/^[a-zA-Z]$/.test(event.key)) return;

  const letter = event.key.toUpperCase();
  const exact = rack.findIndex((tile, index) => !used[index] && tile === letter);
  if (exact >= 0) {
    tapTile(exact);
    return;
  }
  const blank = rack.findIndex((tile, index) => !used[index] && tile === BLANK);
  if (blank >= 0) tapBlank(blank, letter);
}

/* --------------------------------------------------------------- result --- */

function showResult(_finalData?: any): void {
  if (!duel) return;
  const state = duel;
  const outcome = outcomeOf(state);
  const card = buildStudyCard(state.history, state.seed);

  const title =
    outcome === "you" ? "YOU SURVIVED" : outcome === "them" ? "DISMANTLED" : "STALEMATE";
  const tone = outcome === "you" ? "good" : outcome === "them" ? "bad" : "";

  const blocks: string[] = [];
  if (card.bestWord) {
    blocks.push(
      `<div class="report-block"><div class="report-h">Best word of the match</div>` +
        `<div class="word-row"><span class="mini-tile hit">${card.bestWord.word.toUpperCase()}` +
        `<i>${card.bestWord.score}</i></span></div></div>`,
    );
  }
  if (card.tips.length > 0) {
    blocks.push(
      `<div class="report-block"><div class="report-h">How it went</div><ul>` +
        card.tips.map((tip) => `<li>${tip}</li>`).join("") +
        `</ul></div>`,
    );
  }
  if (card.missed.length > 0) {
    blocks.push(
      `<div class="report-block"><div class="report-h">Best words you missed</div>` +
        `<div class="word-row">` +
        card.missed
          .map(
            (m) =>
              `<span class="mini-tile">${m.word.toUpperCase()}<i>${m.score}</i></span>`,
          )
          .join("") +
        `</div></div>`,
    );
  }
  if (card.learning.length > 0) {
    blocks.push(
      `<div class="report-block"><div class="report-h">Two-letter words to learn</div>` +
        `<div class="word-row">` +
        card.learning.map((word) => `<span class="mini-tile">${word.toUpperCase()}</span>`).join("") +
        `</div></div>`,
    );
  }

  const career = recordRun(state, outcome);

  screens.result.innerHTML =
    `<h2 class="result-title ${tone}">${title}</h2>` +
    `<div class="result-sub">${state.round - 1} rounds \u00b7 ${state.hpYou} to ${state.hpThem} health</div>` +
    `<div class="run-note" id="run-note"></div>` +
    blocks.join("") +
    `<button class="primary" id="btn-again">Play Again</button>` +
    `<button class="ghost" id="btn-menu">Back to Lobby</button>`;

  show("result");
  el("btn-again").addEventListener("click", () => {
    if (role === "host") {
      nextRound();
    }
  });
  el("btn-menu").addEventListener("click", () => {
    // Return to lobby or title
    show("lobby");
  });
  void submitRun(career);
}

async function submitRun(career: Career): Promise<void> {
  try {
    const reply = await saveScore({
      pro_wins: career.proWins,
      best_word: career.bestWord,
      best_margin: career.bestMargin,
    });
    const note = el("run-note");
    if (reply && reply.ok && reply.result) {
      note.textContent = reply.result.improved
        ? `New best - you are #${reply.result.rank}.`
        : `Not your best this time (#${reply.result.rank}).`;
      note.classList.toggle("good", reply.result.improved);
    }
    void loadBoard();
  } catch (error) {
    /* offline or start.ng unavailable - career kept locally */
  }
}

async function loadBoard(): Promise<void> {
  try {
    const board = await readBoard(10);
    if (!board) return;
    const list = el("board-list");
    list.innerHTML = board
      .map(
        (entry) =>
          `<li class="${entry.player_id === me?.id ? "me" : ""}">` +
          `<span class="board-rank">#${entry.rank}</span>` +
          `<span class="board-name">${escapeHtml(entry.name)}</span>` +
          `<span class="board-stats">${entry.stats.pro_wins || 0} wins \u00b7 best ${entry.stats.best_word || 0} \u00b7 round ${entry.stats.best_margin || 0}</span>` +
          `</li>`,
      )
      .join("");
    el("board-card").hidden = false;
  } catch {
    /* leaderboard unavailable */
  }
}

/* ----------------------------------------------------------------- boot --- */

function init(): void {
  const createBtn = el<HTMLButtonElement>("btn-create");
  createBtn.addEventListener("click", () => {
    if (createBtn.disabled) return;
    if (lobbyState?.gameStarted) {
      nextRound();
    } else {
      createLobby();
    }
  });
  el("btn-join").addEventListener("click", joinLobby);
  el("btn-shuffle").addEventListener("click", shuffleRack);
  el("btn-clear").addEventListener("click", clearWord);
  el("btn-pass").addEventListener("click", () => submitWord(true));
  el("btn-play").addEventListener("click", () => submitWord(false));
  el("btn-next").addEventListener("click", nextRound);
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    arena.setPaused(document.hidden);
    if (!document.hidden) void refreshPlayer();
  });
  window.addEventListener("focus", () => void refreshPlayer());
}

async function boot(): Promise<void> {
  try {
    await loadDictionary();
    el("dict-note").textContent = `${wordCount().toLocaleString()} words \u00b7 ENABLE list`;
    buildTitle();
    await initMultiplayer();
    await refreshPlayer();
    await loadBoard();
    show("title");
  } catch (error) {
    el("boot-msg").textContent = `Could not load the word list - ${(error as Error).message}`;
  }
}

init();
boot();