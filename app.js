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
  resetButton: document.querySelector("#resetButton"),
  resetDialog: document.querySelector("#resetDialog"),
  resetForm: document.querySelector("#resetForm"),
  cancelReset: document.querySelector("#cancelReset"),
  cancelEntryDialog: document.querySelector("#cancelEntryDialog"),
  cancelEntryForm: document.querySelector("#cancelEntryForm"),
  keepEntry: document.querySelector("#keepEntry"),
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
let cancelTarget = null;

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
      const participantId = crypto.randomUUID();
      next.predictions[scoreKey][participantId] = {
        name,
        paid: false,
        ownerId,
        claimedAt: Date.now(),
      };
      writeLocalState(next);
      return true;
    },
    async setPaid(scoreKey, participantId, paid) {
      const next = normalizedLocalState();
      const participant = next.predictions[scoreKey]?.[participantId];
      if (!participant || participant.ownerId !== ownerId) {
        return false;
      }
      next.predictions[scoreKey][participantId] = { ...participant, paid };
      writeLocalState(next);
      return true;
    },
    async cancelEntry(scoreKey, participantId) {
      const next = normalizedLocalState();
      const participant = next.predictions[scoreKey]?.[participantId];
      if (!participant) {
        return false;
      }
      delete next.predictions[scoreKey][participantId];
      if (Object.keys(next.predictions[scoreKey]).length === 0) {
        delete next.predictions[scoreKey];
      }
      writeLocalState(next);
      return true;
    },
    async reset() {
      writeLocalState({ customScores: {}, predictions: {} });
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
    subscribe(callback, onError) {
      databaseModule.onValue(
        rootRef,
        (snapshot) => {
          const value = snapshot.val() || {};
          callback({
            customScores: value.scoreRows || {},
            predictions: value.predictions || {},
          });
        },
        (error) => onError?.(error),
      );
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
      const scoreRef = databaseModule.ref(database, `predictions/${scoreKey}`);
      const target = databaseModule.push(scoreRef);
      await databaseModule.set(target, {
        name,
        paid: false,
        ownerId,
        claimedAt: databaseModule.serverTimestamp(),
      });
      return true;
    },
    async setPaid(scoreKey, participantId, paid) {
      const target = databaseModule.ref(
        database,
        `predictions/${scoreKey}/${participantId}`,
      );
      const result = await databaseModule.runTransaction(target, (current) => {
        if (!current || current.ownerId !== ownerId) {
          return;
        }
        return { ...current, paid };
      });
      return result.committed;
    },
    async cancelEntry(scoreKey, participantId) {
      const target = databaseModule.ref(
        database,
        `predictions/${scoreKey}/${participantId}`,
      );
      await databaseModule.remove(target);
      return true;
    },
    async reset() {
      const predictionsRef = databaseModule.ref(database, "predictions");
      const scoreRowsRef = databaseModule.ref(database, "scoreRows");
      await Promise.all([
        databaseModule.remove(predictionsRef),
        databaseModule.remove(scoreRowsRef),
      ]);
      return true;
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
  return Object.entries(state.predictions[scoreKey] || {})
    .filter(
      ([, participant]) =>
        participant &&
        typeof participant === "object" &&
        typeof participant.name === "string",
    )
    .map(([id, participant]) => ({ ...participant, id }))
    .sort(
      (a, b) => Number(a.claimedAt || 0) - Number(b.claimedAt || 0),
    );
}

function renderParticipant(participant, scoreKey) {
  const isMine = participant.ownerId === ownerId;
  const statusClass = participant.paid ? "is-paid" : "";
  const paymentControl = isMine
    ? `<button
        type="button"
        class="participant-payment ${statusClass}"
        data-payment="${scoreKey}"
        data-participant="${participant.id}"
        data-paid="${participant.paid ? "true" : "false"}"
      >${participant.paid ? "입금 완료" : "입금 완료하기"}</button>`
    : `<span class="participant-status ${statusClass}">
        ${participant.paid ? "입금 완료" : "입금 전"}
      </span>`;

  const controls = `<span class="participant-controls">
        ${paymentControl}
        <button
          type="button"
          class="participant-cancel"
          data-cancel-score="${scoreKey}"
          data-cancel-participant="${participant.id}"
          data-cancel-name="${escapeHtml(participant.name)}"
        >등록 취소</button>
      </span>`;

  return `
    <li class="participant ${statusClass}">
      <span class="participant-name">${escapeHtml(participant.name)}</span>
      ${controls}
    </li>
  `;
}

function renderScoreCard(score) {
  const people = participantList(score.key);

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
      <form class="claim-form" data-score="${score.key}">
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
      </form>
    </article>
  `;
}

function renderScoreGroup(type, title, description, scores) {
  return `
    <section class="result-group result-group-${type}" aria-labelledby="group-${type}">
      <header class="result-group-header">
        <div class="result-group-mark" aria-hidden="true"></div>
        <div>
          <p>${description}</p>
          <h3 id="group-${type}">${title}</h3>
        </div>
        <div class="result-group-meta">
          <span class="result-group-count">${scores.length}개 스코어</span>
          <span class="result-scroll-hint">옆으로 넘겨보세요 →</span>
        </div>
      </header>
      <div class="result-score-grid">
        ${scores.map(renderScoreCard).join("")}
      </div>
    </section>
  `;
}

function render() {
  const scores = allScores();
  const participants = scores.flatMap((score) => participantList(score.key));
  const paid = participants.filter((participant) => participant.paid);

  elements.claimedCount.textContent = participants.length;
  elements.paidCount.textContent = paid.length;
  elements.availableCount.textContent = scores.length;

  const koreaWins = scores.filter((score) => score.home > score.away);
  const draws = scores.filter((score) => score.home === score.away);
  const mexicoWins = scores.filter((score) => score.home < score.away);

  elements.scoreGrid.innerHTML = [
    renderScoreGroup(
      "korea",
      "대한민국이 이긴다",
      "대한민국의 득점이 더 높은 예상",
      koreaWins,
    ),
    renderScoreGroup(
      "draw",
      "비긴다",
      "대한민국과 멕시코의 득점이 같은 예상",
      draws,
    ),
    renderScoreGroup(
      "mexico",
      "멕시코가 이긴다",
      "멕시코의 득점이 더 높은 예상",
      mexicoWins,
    ),
  ].join("");
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
        : "등록하지 못했습니다.",
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
    const success = await storage.setPaid(
      button.dataset.payment,
      button.dataset.participant,
      nextPaid,
    );
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

function openCancelEntryDialog(button) {
  cancelTarget = {
    scoreKey: button.dataset.cancelScore,
    participantId: button.dataset.cancelParticipant,
    name: button.dataset.cancelName,
  };
  elements.cancelEntryDialog.querySelector("h2").textContent =
    `${cancelTarget.name}님의 등록을 취소할까요?`;
  elements.cancelEntryDialog.showModal();
}

async function handleCancelEntry(form) {
  if (!cancelTarget) {
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "취소 중...";

  try {
    const success = await storage.cancelEntry(
      cancelTarget.scoreKey,
      cancelTarget.participantId,
    );
    elements.cancelEntryDialog.close();
    showToast(
      success
        ? `${cancelTarget.name}님의 등록을 취소했습니다.`
        : "이미 취소되었거나 등록 정보를 찾을 수 없습니다.",
      success ? "success" : "error",
    );
  } catch (error) {
    console.error(error);
    showToast("등록을 취소하지 못했습니다.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "등록 취소";
    cancelTarget = null;
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

function openResetDialog() {
  elements.resetForm.reset();
  if (typeof elements.resetDialog.showModal === "function") {
    elements.resetDialog.showModal();
    elements.resetForm.elements.password.focus();
  }
}

async function handleReset(form) {
  const password = form.elements.password.value;
  const submitButton = form.querySelector('[type="submit"]');

  if (password !== "12") {
    showToast("초기화 비밀번호가 맞지 않습니다.", "error");
    form.elements.password.select();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "초기화 중...";

  try {
    await storage.reset();
    elements.resetDialog.close();
    showToast("테스트 데이터를 초기화했습니다.");
  } catch (error) {
    console.error(error);
    showToast("초기화하지 못했습니다.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "초기화 실행";
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
      elements.connectionLabel.textContent = "공동 저장 연결 중";
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

  render();
  storage.subscribe(
    (nextState) => {
      state = nextState;
      if (storage.mode === "firebase") {
        elements.connectionLabel.textContent = "실시간 공동 저장";
        elements.livePill.classList.add("online");
      }
      render();
    },
    (error) => {
      console.error(error);
      elements.connectionLabel.textContent = "공동 저장 권한 오류";
      elements.livePill.classList.remove("online");
      showToast(
        "Firebase Realtime Database 규칙을 확인해 주세요.",
        "error",
      );
    },
  );
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
    return;
  }

  const cancelButton = event.target.closest("[data-cancel-participant]");
  if (cancelButton) {
    openCancelEntryDialog(cancelButton);
  }
});

elements.addScoreForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleAddScore(event.target);
});

elements.resetButton.addEventListener("click", openResetDialog);

elements.cancelReset.addEventListener("click", () => {
  elements.resetDialog.close();
});

elements.resetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleReset(event.target);
});

elements.keepEntry.addEventListener("click", () => {
  cancelTarget = null;
  elements.cancelEntryDialog.close();
});

elements.cancelEntryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleCancelEntry(event.target);
});

updateCountdown();
setInterval(updateCountdown, 1000);
initialize();
