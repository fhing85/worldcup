const DEFAULT_SCORES = Array.from({ length: 4 }, (_, homeIndex) =>
  Array.from({ length: 4 }, (_, away) => ({
    home: 3 - homeIndex,
    away,
    key: `${3 - homeIndex}-${away}`,
    isDefault: true,
  })),
).flat();

const MATCH_TIME = new Date("2026-06-19T10:00:00+09:00");
const LOCAL_STORAGE_KEY = "civil-office-worldcup-multi-predictions-v2";
const LOCAL_OWNER_KEY = "civil-office-worldcup-owner-v1";

const elements = {
  scoreGrid: document.querySelector("#scoreGrid"),
  addScoreForm: document.querySelector("#addScoreForm"),
  claimedCount: document.querySelector("#claimedCount"),
  paidCount: document.querySelector("#paidCount"),
  availableCount: document.querySelector("#availableCount"),
  connectionLabel: document.querySelector("#connectionLabel"),
  livePill: document.querySelector(".live-pill"),
  countdown: document.querySelector("#countdown"),
  toast: document.querySelector("#toast"),
};

let state = { customScores: {}, predictions: {} };
let ownerId = "";
let storage = null;
let toastTimer = null;

function hasFirebaseConfig() {
  const config = window.FIREBASE_CONFIG;
  return Boolean(
    config &&
      config.apiKey &&
      !config.apiKey.startsWith("YOUR_") &&
      config.projectId &&
      !config.projectId.startsWith("YOUR_"),
  );
}

function getOrCreateLocalOwnerId() {
  let id = localStorage.getItem(LOCAL_OWNER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LOCAL_OWNER_KEY, id);
  }
  return id;
}

function readLocalState() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function normalizedLocalState() {
  const current = readLocalState();
  return {
    customScores: current.customScores || {},
    predictions: current.predictions || {},
  };
}

function writeLocalState(next) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("local-predictions-updated"));
}

function createLocalStorageAdapter() {
  ownerId = getOrCreateLocalOwnerId();

  const notify = (callback) => callback(normalizedLocalState());

  return {
    mode: "local",
    subscribe(callback) {
      const handler = () => notify(callback);
      window.addEventListener("storage", handler);
      window.addEventListener("local-predictions-updated", handler);
      notify(callback);
    },
    async addScore(score) {
      const next = normalizedLocalState();
      if (
        DEFAULT_SCORES.some((item) => item.key === score.key) ||
        next.customScores[score.key]
      ) {
        return false;
      }
      next.customScores[score.key] = {
        home: score.home,
        away: score.away,
        createdAt: Date.now(),
        createdBy: ownerId,
      };
      writeLocalState(next);
      return true;
    },
    async register(scoreKey, name) {
      const next = normalizedLocalState();
      next.predictions[scoreKey] ||= {};
      if (next.predictions[scoreKey][ownerId]) {
        return false;
      }
      next.predictions[scoreKey][ownerId] = {
        name,
        paid: false,
        ownerId,
        claimedAt: Date.now(),
      };
      writeLocalState(next);
      return true;
    },
    async setPaid(scoreKey, paid) {
      const next = normalizedLocalState();
      const participant = next.predictions[scoreKey]?.[ownerId];
      if (!participant) {
        return false;
      }
      next.predictions[scoreKey][ownerId] = { ...participant, paid };
      writeLocalState(next);
      return true;
    },
  };
}

async function createFirebaseStorageAdapter() {
  const firebaseVersion = "12.14.0";
  const [{ initializeApp }, authModule, databaseModule] = await Promise.all([
    import(
      `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`
    ),
    import(
      `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-auth.js`
    ),
    import(
      `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-database.js`
    ),
  ]);

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = authModule.getAuth(app);
  const credential = await authModule.signInAnonymously(auth);
  ownerId = credential.user.uid;

  const database = databaseModule.getDatabase(app);
  const rootRef = databaseModule.ref(database);

  return {
    mode: "firebase",
    subscribe(callback) {
      databaseModule.onValue(rootRef, (snapshot) => {
        const value = snapshot.val() || {};
        callback({
          customScores: value.scoreRows || {},
          predictions: value.predictions || {},
        });
      });
    },
    async addScore(score) {
      if (DEFAULT_SCORES.some((item) => item.key === score.key)) {
        return false;
      }
      const target = databaseModule.ref(database, `scoreRows/${score.key}`);
      const result = await databaseModule.runTransaction(target, (current) => {
        if (current) {
          return;
        }
        return {
          home: score.home,
          away: score.away,
          createdAt: databaseModule.serverTimestamp(),
          createdBy: ownerId,
        };
      });
      return result.committed;
    },
    async register(scoreKey, name) {
      const target = databaseModule.ref(
        database,
        `predictions/${scoreKey}/${ownerId}`,
      );
      const result = await databaseModule.runTransaction(target, (current) => {
        if (current) {
          return;
        }
        return {
          name,
          paid: false,
          ownerId,
          claimedAt: databaseModule.serverTimestamp(),
        };
      });
      return result.committed;
    },
    async setPaid(scoreKey, paid) {
      const target = databaseModule.ref(
        database,
        `predictions/${scoreKey}/${ownerId}`,
      );
      const result = await databaseModule.runTransaction(target, (current) => {
        if (!current || current.ownerId !== ownerId) {
          return;
        }
        return { ...current, paid };
      });
      return result.committed;
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function allScores() {
  const defaults = new Map(DEFAULT_SCORES.map((score) => [score.key, score]));
  const custom = Object.entries(state.customScores).map(([key, score]) => ({
    key,
    home: Number(score.home),
    away: Number(score.away),
    isDefault: false,
    createdAt: score.createdAt || 0,
  }));

  custom.sort(
    (a, b) =>
      Number(a.createdAt) - Number(b.createdAt) ||
      b.home - a.home ||
      a.away - b.away,
  );
  return [...defaults.values(), ...custom.filter((score) => !defaults.has(score.key))];
}

function participantList(scoreKey) {
  return Object.values(state.predictions[scoreKey] || {})
    .filter(
      (participant) =>
        participant &&
        typeof participant === "object" &&
        typeof participant.name === "string",
    )
    .sort(
      (a, b) => Number(a.claimedAt || 0) - Number(b.claimedAt || 0),
    );
}

function renderParticipant(participant, scoreKey) {
  const isMine = participant.ownerId === ownerId;
  const statusClass = participant.paid ? "is-paid" : "";
  const button = isMine
    ? `<button
        type="button"
        class="participant-payment ${statusClass}"
        data-payment="${scoreKey}"
        data-paid="${participant.paid ? "true" : "false"}"
      >${participant.paid ? "입금 완료" : "입금 완료하기"}</button>`
    : `<span class="participant-status ${statusClass}">
        ${participant.paid ? "입금 완료" : "입금 전"}
      </span>`;

  return `
    <li class="participant ${statusClass}">
      <span class="participant-name">${escapeHtml(participant.name)}</span>
      ${button}
    </li>
  `;
}

function render() {
  const scores = allScores();
  const participants = scores.flatMap((score) => participantList(score.key));
  const paid = participants.filter((participant) => participant.paid);

  elements.claimedCount.textContent = participants.length;
  elements.paidCount.textContent = paid.length;
  elements.availableCount.textContent = scores.length;

  elements.scoreGrid.innerHTML = scores
    .map((score) => {
      const people = participantList(score.key);
      const myEntry = people.find((person) => person.ownerId === ownerId);

      return `
        <article class="score-card ${people.length ? "has-participants" : ""}" data-score="${score.key}">
          <div class="card-top">
            <div class="score-number">${score.home}<i>:</i>${score.away}</div>
            <span class="status-tag">${people.length}명 참여</span>
          </div>
          ${
            people.length
              ? `<ul class="participant-list">${people
                  .map((person) => renderParticipant(person, score.key))
                  .join("")}</ul>`
              : `<p class="empty-participants">아직 참여자가 없습니다.</p>`
          }
          ${
            myEntry
              ? `<p class="already-joined">이 스코어에 등록되었습니다.</p>`
              : `<form class="claim-form" data-score="${score.key}">
                  <label class="sr-only" for="name-${score.key}">이름</label>
                  <input
                    id="name-${score.key}"
                    class="name-input"
                    name="name"
                    type="text"
                    maxlength="12"
                    placeholder="이름을 입력하세요"
                    autocomplete="name"
                    required
                  />
                  <button class="claim-button" type="submit">이 스코어에 등록</button>
                </form>`
          }
        </article>
      `;
    })
    .join("");
}

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type} show`;
  toastTimer = setTimeout(() => {
    elements.toast.className = "toast";
  }, 2600);
}

async function handleRegistration(form) {
  const button = form.querySelector("button");
  const input = form.elements.name;
  const name = input.value.trim();

  if (!name) {
    showToast("이름을 입력해 주세요.", "error");
    input.focus();
    return;
  }

  button.disabled = true;
  input.disabled = true;
  button.textContent = "등록 중...";

  try {
    const success = await storage.register(form.dataset.score, name);
    showToast(
      success
        ? `${name}님의 예상이 등록되었습니다.`
        : "이 기기에서는 해당 스코어에 이미 등록했습니다.",
      success ? "success" : "error",
    );
  } catch (error) {
    console.error(error);
    showToast("등록하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    button.disabled = false;
    input.disabled = false;
    button.textContent = "이 스코어에 등록";
  }
}

async function handlePayment(button) {
  const nextPaid = button.dataset.paid !== "true";
  button.disabled = true;

  try {
    const success = await storage.setPaid(button.dataset.payment, nextPaid);
    showToast(
      success
        ? nextPaid
          ? "입금 완료로 표시했습니다."
          : "입금 완료 표시를 해제했습니다."
        : "본인 이름의 입금 상태만 변경할 수 있습니다.",
      success ? "success" : "error",
    );
  } catch (error) {
    console.error(error);
    showToast("입금 상태를 변경하지 못했습니다.", "error");
    render();
  }
}

async function handleAddScore(form) {
  const home = Number(form.elements.homeScore.value);
  const away = Number(form.elements.awayScore.value);
  const button = form.querySelector("button");

  if (
    !Number.isInteger(home) ||
    !Number.isInteger(away) ||
    home < 0 ||
    away < 0 ||
    home > 99 ||
    away > 99
  ) {
    showToast("0부터 99까지의 정수 점수를 입력해 주세요.", "error");
    return;
  }

  button.disabled = true;
  button.textContent = "추가 중...";

  try {
    const success = await storage.addScore({
      home,
      away,
      key: `${home}-${away}`,
    });
    if (success) {
      form.reset();
      showToast(`${home}:${away} 예상 스코어 행을 추가했습니다.`);
    } else {
      showToast("이미 있는 예상 스코어입니다.", "error");
    }
  } catch (error) {
    console.error(error);
    showToast("행을 추가하지 못했습니다.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "행 추가";
  }
}

function updateCountdown() {
  const distance = MATCH_TIME.getTime() - Date.now();
  if (distance <= 0) {
    elements.countdown.textContent = "경기가 시작되었습니다";
    return;
  }

  const days = Math.floor(distance / 86_400_000);
  const hours = Math.floor((distance % 86_400_000) / 3_600_000);
  const minutes = Math.floor((distance % 3_600_000) / 60_000);
  const seconds = Math.floor((distance % 60_000) / 1_000);
  elements.countdown.textContent = `${days}일 ${String(hours).padStart(2, "0")}시간 ${String(minutes).padStart(2, "0")}분 ${String(seconds).padStart(2, "0")}초`;
}

async function initialize() {
  try {
    if (hasFirebaseConfig()) {
      storage = await createFirebaseStorageAdapter();
      elements.connectionLabel.textContent = "실시간 공동 저장";
      elements.livePill.classList.add("online");
    } else {
      storage = createLocalStorageAdapter();
      elements.connectionLabel.textContent = "이 기기 데모 저장";
    }
  } catch (error) {
    console.error(error);
    storage = createLocalStorageAdapter();
    elements.connectionLabel.textContent = "오프라인 데모 저장";
    showToast("공동 저장 연결에 실패해 데모 모드로 시작합니다.", "error");
  }

  storage.subscribe((nextState) => {
    state = nextState;
    render();
  });
}

elements.scoreGrid.addEventListener("submit", (event) => {
  if (!event.target.matches(".claim-form")) {
    return;
  }
  event.preventDefault();
  handleRegistration(event.target);
});

elements.scoreGrid.addEventListener("click", (event) => {
  const paymentButton = event.target.closest("[data-payment]");
  if (paymentButton) {
    handlePayment(paymentButton);
  }
});

elements.addScoreForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAddScore(event.target);
});

updateCountdown();
setInterval(updateCountdown, 1000);
initialize();
