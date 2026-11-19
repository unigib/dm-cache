"use strict";

const ADDRESS_BITS = 16;
const MEMORY_SIZE = 2 ** ADDRESS_BITS;
const CACHE_LINES = 256;
const BLOCK_SIZE = 4;
const HISTORY_LIMIT = 12;
const HIT_TIME = 1;
const MISS_TIME = 10;
const MAX_RUN_READS = 10000;
const memory = Uint8Array.from({ length: MEMORY_SIZE }, (_, address) => address);

const elements = {
  form: document.querySelector("#access-form"),
  address: document.querySelector("#address"),
  previewBinary: document.querySelector("#preview-binary"),
  previewDecimal: document.querySelector("#preview-decimal"),
  previewHex: document.querySelector("#preview-hex"),
  error: document.querySelector("#address-error"),
  reset: document.querySelector("#reset-cache"),
  empty: document.querySelector("#empty-cache"),
  start: document.querySelector("#start-access"),
  nextStage: document.querySelector("#next-stage"),
  cycleMessage: document.querySelector("#cycle-message"),
  random: document.querySelector("#random-address"),
  cacheCount: document.querySelector("#cache-count"),
  cacheBody: document.querySelector("#cache-body"),
  cacheTableWrap: document.querySelector(".cache-table-wrap"),
  loadedOnly: document.querySelector("#loaded-only"),
  loadedCount: document.querySelector("#loaded-count"),
  tableEmpty: document.querySelector("#table-empty"),
  fillList: document.querySelector("#fill-list"),
  fillEmpty: document.querySelector("#fill-empty"),
  fillCount: document.querySelector("#fill-count"),
  readInsight: document.querySelector("#read-insight"),
  accesses: document.querySelector("#access-count"),
  hits: document.querySelector("#hit-count"),
  misses: document.querySelector("#miss-count"),
  hitRate: document.querySelector("#hit-rate"),
  journeyEmpty: document.querySelector("#journey-empty"),
  journeyResult: document.querySelector("#journey-result"),
  addressBadge: document.querySelector("#address-badge"),
  banner: document.querySelector("#result-banner"),
  decimal: document.querySelector("#address-decimal"),
  bits: document.querySelector("#address-bits"),
  blockCalc: document.querySelector("#block-calc"),
  lineCalc: document.querySelector("#line-calc"),
  tagCalc: document.querySelector("#tag-calc"),
  historyEmpty: document.querySelector("#history-empty"),
  historyList: document.querySelector("#history-list"),
  historyCount: document.querySelector("#history-count"),
  programSelect: document.querySelector("#program-select"),
  programDescription: document.querySelector("#program-description"),
  programCode: document.querySelector("#program-code"),
  programStep: document.querySelector("#program-step"),
  programPass: document.querySelector("#program-pass"),
  programRun: document.querySelector("#program-run"),
  programProgress: document.querySelector("#program-progress"),
  cpuPc: document.querySelector("#cpu-pc"),
  cpuA: document.querySelector("#cpu-a"),
  cpuXY: document.querySelector("#cpu-xy"),
  cpuFlags: document.querySelector("#cpu-flags"),
  cpuEvent: document.querySelector("#cpu-event"),
  passResults: document.querySelector("#pass-results"),
  passBody: document.querySelector("#pass-body"),
  passEmpty: document.querySelector("#pass-empty"),
  cacheTime: document.querySelector("#cache-time"),
  memoryTime: document.querySelector("#memory-time"),
  speedup: document.querySelector("#speedup")
};

let cache = [];
let history = [];
let fills = [];
let hits = 0;
let accesses = 0;
let lastLine = null;
let lastHit = false;
let lastAccess = null;
let pending = null;
const CODE_START = 0x0200;
const programs = {
  loop: {
    description: "Three passes over 16 bytes at $0400–$040F. Select Clear cache & restart, then Run next pass to compare cold and warm cache behavior.",
    instructions: [
      { bytes: [0xA0, 0x03], assembly: "LDY #$03       ; 3 passes" },
      { bytes: [0xA2, 0x00], assembly: "pass: LDX #$00 ; start at element 0" },
      { bytes: [0xBD, 0x00, 0x04], assembly: "loop: LDA $0400,X ; read array[X]" },
      { bytes: [0xE8], assembly: "INX            ; next element" },
      { bytes: [0xE0, 0x10], assembly: "CPX #$10       ; read 16 elements?" },
      { bytes: [0xD0, 0xF8], assembly: "BNE loop       ; repeat until X = 16" },
      { bytes: [0x88], assembly: "DEY            ; one pass completed" },
      { bytes: [0xD0, 0xF3], assembly: "BNE pass       ; repeat while Y != 0" }
    ],
    data: Array.from({ length: 16 }, (_, index) => ({ address: 0x0400 + index, value: index + 1 }))
  },
  arithmetic: {
    description: "Start with 5, then add the two data bytes at $0400 and $0401. The expected accumulator is $0E.",
    instructions: [
      { bytes: [0xA9, 0x05], assembly: "LDA #$05       ; A = 5" },
      { bytes: [0x18], assembly: "CLC            ; clear carry before addition" },
      { bytes: [0x6D, 0x00, 0x04], assembly: "ADC $0400      ; add first data byte" },
      { bytes: [0x6D, 0x01, 0x04], assembly: "ADC $0401      ; add second data byte" }
    ],
    data: [{ address: 0x0400, value: 0x07 }, { address: 0x0401, value: 0x02 }]
  },
  sequential: {
    description: "Read three neighboring data bytes. They share one cache block, so the first data read loads all four.",
    instructions: [
      { bytes: [0xAD, 0x00, 0x04], assembly: "LDA $0400      ; load first byte" },
      { bytes: [0xAD, 0x01, 0x04], assembly: "LDA $0401      ; load neighboring byte" },
      { bytes: [0xAD, 0x02, 0x04], assembly: "LDA $0402      ; load another neighbor" }
    ],
    data: [{ address: 0x0400, value: 0x11 }, { address: 0x0401, value: 0x22 }, { address: 0x0402, value: 0x33 }]
  },
  conflict: {
    description: "The first instruction at $0200 and data at $0600 map to the same cache line. Watch data evict code and the next opcode fetch evict data.",
    instructions: [
      { bytes: [0xAD, 0x00, 0x06], assembly: "LDA $0600      ; data replaces code" },
      { bytes: [0xAD, 0x00, 0x06], assembly: "LDA $0600      ; code and data conflict again" }
    ],
    data: [{ address: 0x0600, value: 0x42 }]
  }
};
let program;
let cpu;

function formatByte(value) {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatAddress(value) {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function parseAddress(value) {
  const input = value.trim();
  if (!/^(?:\d+|0x[0-9a-f]+|0b[01]+)$/i.test(input)) return null;
  const address = /^[01]{16}$/.test(input) ? parseInt(input, 2) : Number(input);
  return Number.isSafeInteger(address) && address >= 0 && address < MEMORY_SIZE ? address : null;
}

function updateAddressPreview() {
  const address = parseAddress(elements.address.value);
  elements.previewBinary.textContent = address === null ? "—" : address.toString(2).padStart(ADDRESS_BITS, "0");
  elements.previewDecimal.textContent = address === null ? "—" : String(address);
  elements.previewHex.textContent = address === null ? "—" : `0x${address.toString(16).toUpperCase().padStart(4, "0")}`;
}

function resetProgram() {
  program = programs[elements.programSelect.value];
  memory.forEach((_, address) => { memory[address] = address % 256; });
  let address = CODE_START;
  program.instructions.forEach(instruction => {
    memory.set(instruction.bytes, address);
    address += instruction.bytes.length;
  });
  program.data.forEach(item => { memory[item.address] = item.value; });
  cpu = { pc: CODE_START, a: 0, x: 0, y: 0, carry: 0, zero: 0, negative: 0, overflow: 0,
    phase: "opcode", opcode: null, low: 0, target: 0, instructionAddress: CODE_START,
    end: address, reads: 0, hits: 0, event: "Ready: the next read fetches the first opcode.", halted: false,
    passes: [], passStart: null };
  elements.programDescription.textContent = program.description;
  renderProgram();
}

function renderProgram() {
  let address = CODE_START;
  const lines = program.instructions.map(instruction => {
    const line = document.createElement("span");
    line.className = "code-line";
    if (!cpu.halted && (cpu.phase === "opcode" ? cpu.pc : cpu.instructionAddress) === address) line.classList.add("code-next");
    const bytes = instruction.bytes.map(byte => formatByte(byte).slice(2)).join(" ");
    line.textContent = `${formatAddress(address)}  ${bytes.padEnd(8)}  ${instruction.assembly}`;
    address += instruction.bytes.length;
    return line;
  });
  const dataHeading = document.createElement("span");
  dataHeading.className = "code-setup";
  dataHeading.textContent = "\n; Data in memory:";
  const dataLines = program.data.map(item => {
    const line = document.createElement("span");
    line.className = "code-line";
    line.textContent = `${formatAddress(item.address)}  ${formatByte(memory[item.address]).slice(2)}        .byte $${formatByte(memory[item.address]).slice(2)}`;
    return line;
  });
  elements.programCode.replaceChildren(...lines, dataHeading, ...dataLines);
  elements.cpuPc.textContent = formatAddress(cpu.pc);
  elements.cpuA.textContent = formatByte(cpu.a);
  elements.cpuXY.textContent = `${formatByte(cpu.x)} / ${formatByte(cpu.y)}`;
  elements.cpuFlags.textContent = `${cpu.carry} / ${cpu.zero} / ${cpu.negative} / ${cpu.overflow}`;
  elements.cpuEvent.textContent = cpu.event;
  elements.programProgress.textContent = `${cpu.reads} CPU reads${cpu.halted ? " · finished" : ""}`;
  elements.programStep.disabled = cpu.halted;
  elements.programRun.disabled = cpu.halted;
  elements.programPass.hidden = elements.programSelect.value !== "loop";
  elements.programPass.disabled = cpu.halted;
  elements.passResults.hidden = elements.programSelect.value !== "loop";
  elements.passEmpty.hidden = cpu.passes.length > 0;
  elements.passBody.replaceChildren(...cpu.passes.map((pass, index) => {
    const row = document.createElement("tr");
    const values = [index + 1, pass.reads, pass.hits, pass.misses,
      `${pass.hits * HIT_TIME + pass.misses * MISS_TIME} units`, `${pass.reads * MISS_TIME} units`];
    values.forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    return row;
  }));
}

function setNZ(value) {
  cpu.zero = Number(value === 0);
  cpu.negative = Number((value & 0x80) !== 0);
}

function finishInstruction() {
  cpu.phase = "opcode";
  if (cpu.pc === cpu.end) {
    cpu.halted = true;
    cpu.event += " End of example program.";
  }
}

function stepProgram(updateDisplay = true) {
  if (cpu.halted) return;
  const address = cpu.phase === "data" ? cpu.target : cpu.pc;
  const kind = cpu.phase === "opcode" ? "Opcode fetch" : cpu.phase === "data" ? "Data read" : "Operand fetch";
  elements.address.value = address;
  updateAddressPreview();
  elements.error.textContent = "";
  elements.address.removeAttribute("aria-invalid");
  const value = accessAddress(address, kind, updateDisplay);
  cpu.reads += 1;
  if (lastHit) cpu.hits += 1;
  if (cpu.phase !== "data") cpu.pc = (cpu.pc + 1) & 0xFFFF;
  cpu.event = `${kind}: ${formatAddress(address)} → ${formatByte(value)}.`;
  switch (cpu.phase) {
    case "opcode":
      cpu.instructionAddress = address;
      cpu.opcode = value;
      if (value === 0x18) {
        cpu.carry = 0;
        cpu.event += " CLC clears carry.";
        finishInstruction();
      } else if (value === 0xE8 || value === 0x88) {
        const register = value === 0xE8 ? "x" : "y";
        cpu[register] = (cpu[register] + (value === 0xE8 ? 1 : -1)) & 0xFF;
        setNZ(cpu[register]);
        cpu.event += ` ${value === 0xE8 ? "INX" : "DEY"} sets ${register.toUpperCase()} = ${formatByte(cpu[register])}.`;
        finishInstruction();
      } else if (value === 0xA9 || value === 0xA0 || value === 0xA2 || value === 0xE0 || value === 0xD0) {
        cpu.phase = "immediate";
      } else if (value === 0xAD || value === 0x6D || value === 0xBD) {
        cpu.phase = "low";
      } else {
        throw new Error(`Unsupported 6502 opcode ${formatByte(value)} at ${formatAddress(address)}.`);
      }
      break;
    case "immediate":
      if (cpu.opcode === 0xD0) {
        const taken = cpu.zero === 0;
        if (taken) cpu.pc = (cpu.pc + (value < 0x80 ? value : value - 0x100)) & 0xFFFF;
        cpu.event += ` BNE ${taken ? `branches to ${formatAddress(cpu.pc)}` : "is not taken"}.`;
        if (elements.programSelect.value === "loop" && cpu.instructionAddress === 0x020D) {
          const passReads = cpu.reads - cpu.passStart.reads;
          const passHits = cpu.hits - cpu.passStart.hits;
          cpu.passes.push({ reads: passReads, hits: passHits, misses: passReads - passHits });
          cpu.passStart = { reads: cpu.reads, hits: cpu.hits };
        }
      } else if (cpu.opcode === 0xE0) {
        const difference = (cpu.x - value) & 0xFF;
        cpu.carry = Number(cpu.x >= value);
        setNZ(difference);
        cpu.event += ` CPX compares X with ${formatByte(value)}.`;
      } else {
        const register = cpu.opcode === 0xA9 ? "a" : cpu.opcode === 0xA2 ? "x" : "y";
        cpu[register] = value;
        setNZ(value);
        cpu.event += ` LD${register.toUpperCase()} loads ${register.toUpperCase()} = ${formatByte(value)}.`;
        if (elements.programSelect.value === "loop" && cpu.instructionAddress === CODE_START) {
          cpu.passStart = { reads: cpu.reads, hits: cpu.hits };
        }
      }
      finishInstruction();
      break;
    case "low":
      cpu.low = value;
      cpu.phase = "high";
      break;
    case "high":
      cpu.target = ((cpu.low | (value << 8)) + (cpu.opcode === 0xBD ? cpu.x : 0)) & 0xFFFF;
      cpu.phase = "data";
      cpu.event += ` Effective address: ${formatAddress(cpu.target)} (little-endian).`;
      break;
    case "data":
      if (cpu.opcode === 0xAD || cpu.opcode === 0xBD) {
        cpu.a = value;
        setNZ(cpu.a);
        cpu.event += ` LDA loads A = ${formatByte(cpu.a)}.`;
      } else if (cpu.opcode === 0x6D) {
        const oldA = cpu.a;
        const sum = oldA + value + cpu.carry;
        cpu.a = sum & 0xFF;
        cpu.carry = Number(sum > 0xFF);
        cpu.overflow = Number((~(oldA ^ value) & (oldA ^ cpu.a) & 0x80) !== 0);
        setNZ(cpu.a);
        cpu.event += ` ADC sets A = ${formatByte(cpu.a)}.`;
      } else {
        throw new Error(`Invalid opcode ${formatByte(cpu.opcode)} for data read.`);
      }
      finishInstruction();
      break;
    default:
      throw new Error(`Invalid CPU phase: ${cpu.phase}`);
  }
  if (updateDisplay) {
    setCycleStage(null, "The assembly program performs CPU reads directly. See the latest read in Anatomy of an access and Access history; use manual lookup to step through the cache-check stages.");
    renderProgram();
  }
}

function resetCache(populated = true) {
  history = [];
  fills = [];
  hits = 0;
  accesses = 0;
  lastLine = null;
  lastAccess = null;
  elements.error.textContent = "";
  elements.address.removeAttribute("aria-invalid");
  elements.journeyEmpty.hidden = false;
  elements.journeyResult.hidden = true;
  elements.addressBadge.textContent = "AWAITING INPUT";
  elements.cacheTableWrap.scrollTop = 0;
  elements.readInsight.textContent = "Step a CPU read or enter an address to see which four-byte block is accessed.";
  elements.readInsight.className = "read-insight";
  resetProgram();
  cache = Array.from({ length: CACHE_LINES }, (_, line) => {
    if (!populated) return null;
    const tag = line % 4;
    const block = tag * CACHE_LINES + line;
    return { block, tag, bytes: Array.from(memory.slice(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE)) };
  });
  pending = null;
  setCycleStage(null, populated
    ? "Enter an address to begin. Each line starts valid, with a tag equal to its line number modulo 4."
    : "Enter an address to begin. The cache is empty, so the first access to each block will miss.");
  setManualBusy(false);
  render();
}

function setManualBusy(busy) {
  elements.start.disabled = busy;
  elements.address.disabled = busy;
  elements.programSelect.disabled = busy;
  elements.programStep.disabled = busy || cpu.halted;
  elements.programRun.disabled = busy || cpu.halted;
  elements.programPass.disabled = busy || cpu.halted;
  document.querySelectorAll(".example").forEach(button => { button.disabled = busy; });
  elements.nextStage.disabled = !busy;
}

function setCycleStage(stage, message) {
  document.querySelectorAll(".cycle-steps li").forEach(item => {
    item.classList.toggle("current-stage", item.id === `stage-${stage}`);
  });
  elements.cycleMessage.textContent = message;
}

function render() {
  elements.cacheCount.textContent = `/ ${cache.length} lines`;
  elements.accesses.textContent = accesses;
  elements.hits.textContent = hits;
  elements.misses.textContent = accesses - hits;
  elements.hitRate.textContent = accesses ? `${Math.round(hits / accesses * 100)}%` : "—";
  const cacheTime = hits * HIT_TIME + (accesses - hits) * MISS_TIME;
  const memoryTime = accesses * MISS_TIME;
  elements.cacheTime.textContent = cacheTime;
  elements.memoryTime.textContent = memoryTime;
  elements.speedup.textContent = accesses ? `${(memoryTime / cacheTime).toFixed(2)}×` : "—";

  const loaded = cache.filter(entry => entry !== null).length;
  elements.loadedCount.textContent = `${loaded} / ${CACHE_LINES} lines loaded`;
  elements.tableEmpty.hidden = !elements.loadedOnly.checked || loaded > 0 || pending !== null;
  elements.cacheBody.replaceChildren(...cache.map((entry, index) => {
    const row = document.createElement("tr");
    row.hidden = elements.loadedOnly.checked && !entry && (!pending || pending.line !== index);
    const active = index === lastLine;
    if (active) row.className = lastHit ? "row-hit" : "row-miss";
    const values = [
      `<span class="line-id">${String(index).padStart(3, "0")} / ${index.toString(2).padStart(8, "0")}</span>`,
      entry ? '<span class="valid-on">1</span>' : '<span class="muted">0</span>',
      entry ? `<span class="mono">${entry.tag.toString(2).padStart(6, "0")}</span>` : '<span class="muted">—</span>',
      entry ? `<span class="block-pill">BLOCK ${entry.block}</span>` : '<span class="muted">—</span>',
      entry ? `<span class="mono">${formatAddress(entry.block * BLOCK_SIZE)}–${formatAddress(entry.block * BLOCK_SIZE + BLOCK_SIZE - 1)}</span>` : '<span class="muted">—</span>',
      ...Array.from({ length: BLOCK_SIZE }, (_, offset) => entry
        ? `<span class="mono data-bytes">${formatByte(entry.bytes[offset])}</span>`
        : '<span class="muted">—</span>'),
      active ? `<span class="status-pill ${lastHit ? "hit" : "miss"}">${lastHit ? "HIT" : "MISS"}</span>` : '<span class="muted">—</span>'
    ];
    row.innerHTML = values.map(value => `<td>${value}</td>`).join("");
    return row;
  }));

  elements.fillCount.textContent = `${accesses - hits} ${(accesses - hits) === 1 ? "fill" : "fills"}`;
  elements.fillEmpty.hidden = fills.length > 0;
  elements.fillList.replaceChildren(...fills.map(fill => {
    const item = document.createElement("li");
    const description = document.createElement("span");
    description.textContent = `#${fill.number} ${fill.kind} ${formatAddress(fill.address)} → line ${fill.line}, tag ${fill.tag.toString(2).padStart(6, "0")}`;
    const detail = document.createElement("span");
    detail.textContent = `${formatAddress(fill.block * BLOCK_SIZE)}–${formatAddress(fill.block * BLOCK_SIZE + BLOCK_SIZE - 1)}: ${fill.bytes.map(formatByte).join(" ")}${fill.replaced === null ? " · empty line" : ` · replaced block ${fill.replaced}`}`;
    item.append(description, detail);
    return item;
  }));

  elements.historyCount.textContent = `${accesses} ${accesses === 1 ? "ACCESS" : "ACCESSES"}`;
  elements.historyEmpty.hidden = history.length > 0;
  elements.historyList.replaceChildren(...history.map(item => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="history-number">#${item.number}</span><span class="history-address">${item.kind} <strong>${formatAddress(item.address)}</strong></span><span class="history-detail">Block ${item.block} <span>→</span> Line ${item.line}</span><span class="status-pill ${item.hit ? "hit" : "miss"}">${item.hit ? "HIT" : "MISS"}</span>`;
    return li;
  }));
}

function accessAddress(address, kind = "Manual read", updateDisplay = true) {
  const block = Math.floor(address / BLOCK_SIZE);
  const line = block % cache.length;
  const tag = Math.floor(block / cache.length);
  const previous = cache[line];
  const hit = previous !== null && previous.tag === tag;
  accesses += 1;
  if (hit) hits += 1;
  if (!hit) {
    cache[line] = { block, tag, bytes: Array.from(memory.slice(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE)) };
    fills.unshift({ number: accesses, kind, address, line, tag, block,
      bytes: cache[line].bytes.slice(), replaced: previous ? previous.block : null });
    fills = fills.slice(0, HISTORY_LIMIT);
  }
  lastLine = line;
  lastHit = hit;
  history.unshift({ number: accesses, address, block, line, hit, kind });
  history = history.slice(0, HISTORY_LIMIT);

  let explanation = `Block ${block} is already in line ${line}.`;
  if (!hit) {
    explanation = previous
      ? `Block ${block} replaces block ${previous.block} in line ${line}.`
      : `Block ${block} is loaded into empty line ${line}.`;
  }
  const value = cache[line].bytes[address % BLOCK_SIZE];
  lastAccess = { address, line, hit, kind, explanation, value, block, bytes: cache[line].bytes.slice() };
  if (updateDisplay) renderLastAccess();
  return value;
}

function renderLastAccess() {
  const { address, line, hit, kind, explanation, value, block, bytes } = lastAccess;
  elements.banner.className = `result-banner ${hit ? "banner-hit" : "banner-miss"}`;
  elements.banner.textContent = `${kind} ${formatAddress(address)}: ${hit ? "Cache hit!" : "Cache miss."} ${explanation} Read value: ${formatByte(value)}.`;
  elements.readInsight.className = `read-insight ${hit ? "insight-hit" : "insight-miss"}`;
  elements.readInsight.textContent = `${kind} ${formatAddress(address)}: ${hit ? "HIT — no memory fetch." : "MISS — loaded all 4 bytes from main memory."} Line ${line}, ${formatAddress(block * BLOCK_SIZE)}–${formatAddress(block * BLOCK_SIZE + BLOCK_SIZE - 1)}: ${bytes.map(formatByte).join(" ")}. Requested byte: ${formatByte(value)}.`;
  showAddress(address);
  render();
  scrollToLine(line);
}
function showAddress(address) {
  const block = Math.floor(address / BLOCK_SIZE);
  const line = block % CACHE_LINES;
  const tag = Math.floor(block / CACHE_LINES);
  const offsetBits = Math.log2(BLOCK_SIZE);
  const indexBits = Math.log2(CACHE_LINES);
  const tagBits = ADDRESS_BITS - indexBits - offsetBits;
  elements.journeyEmpty.hidden = true;
  elements.journeyResult.hidden = false;
  elements.addressBadge.textContent = `ADDRESS ${address}`;
  elements.decimal.textContent = `= ${address} / ${formatAddress(address)}`;
  const bits = address.toString(2).padStart(ADDRESS_BITS, "0");
  elements.bits.replaceChildren(...[...bits].map((bit, index) => {
    const span = document.createElement("span");
    span.className = index < tagBits ? "tag-bit" : index < tagBits + indexBits ? "index-bit" : "offset-bit";
    span.textContent = bit;
    return span;
  }));
  elements.blockCalc.textContent = `${address} ÷ ${BLOCK_SIZE} = ${block}`;
  elements.lineCalc.textContent = `${block} mod ${CACHE_LINES} = ${line}`;
  elements.tagCalc.textContent = `${block} ÷ ${CACHE_LINES} = ${tag} (${tag.toString(2).padStart(6, "0")})`;
}

function scrollToLine(line) {
  const row = elements.cacheBody.children[line];
  const tableTop = elements.cacheTableWrap.getBoundingClientRect().top;
  elements.cacheTableWrap.scrollTop += row.getBoundingClientRect().top - tableTop - elements.cacheTableWrap.querySelector("thead").offsetHeight;
}

function nextManualStage() {
  const { address, line, tag, offset, block } = pending;
  if (pending.phase === "fetch") {
    showAddress(address);
    render();
    elements.banner.className = "result-banner banner-neutral";
    elements.banner.textContent = "Address decoded. The cache has not been checked yet.";
    scrollToLine(line);
    setCycleStage("decode", `Tag ${tag.toString(2).padStart(6, "0")} · index ${line.toString(2).padStart(8, "0")} (line ${line}) · offset ${offset.toString(2).padStart(2, "0")} (byte ${offset}).`);
    pending.phase = "decode";
  } else if (pending.phase === "decode") {
    const entry = cache[line];
    pending.hit = entry !== null && entry.tag === tag;
    if (pending.hit) {
      pending.value = accessAddress(address);
      setCycleStage("lookup", `HIT: line ${line} is valid and tag ${entry.tag.toString(2).padStart(6, "0")} matches. No main-memory fetch is needed.`);
    } else {
      const currentTag = entry ? entry.tag.toString(2).padStart(6, "0") : "invalid";
      elements.banner.className = "result-banner banner-miss";
      elements.banner.textContent = `Cache miss: line ${line} has tag ${currentTag}; requested tag ${tag.toString(2).padStart(6, "0")}. No data has been replaced yet.`;
      setCycleStage("lookup", `MISS: line ${line} ${entry ? `contains tag ${currentTag}, not ${tag.toString(2).padStart(6, "0")}` : "is invalid"}. Next, fetch the full block from main memory.`);
    }
    pending.phase = "lookup";
  } else if (pending.phase === "lookup" && !pending.hit) {
    const start = block * BLOCK_SIZE;
    pending.value = accessAddress(address);
    setCycleStage("memory", `Main memory → cache line ${line}: block ${block}, addresses ${formatAddress(start)}–${formatAddress(start + 3)}, bytes ${cache[line].bytes.map(formatByte).join(" ")}. The previous line contents were replaced.`);
    pending.phase = "memory";
  } else {
    setCycleStage("deliver", `Cache → CPU: offset ${offset.toString(2).padStart(2, "0")} selects byte ${offset}, returning ${formatByte(pending.value)}. Lookup complete.`);
    pending = null;
    setManualBusy(false);
  }
}

elements.form.addEventListener("submit", event => {
  event.preventDefault();
  const value = elements.address.value.trim();
  const address = parseAddress(value);
  if (!/^(?:\d+|0x[0-9a-f]+|0b[01]+)$/i.test(value)) {
    elements.error.textContent = "Enter decimal, 0x-prefixed hex, or 0b-prefixed binary (or exactly 16 binary digits).";
    elements.address.setAttribute("aria-invalid", "true");
    return;
  }
  if (address === null) {
    elements.error.textContent = `Enter an address between 0 and ${MEMORY_SIZE - 1}.`;
    elements.address.setAttribute("aria-invalid", "true");
    return;
  }
  elements.error.textContent = "";
  elements.address.removeAttribute("aria-invalid");
  const block = Math.floor(address / BLOCK_SIZE);
  pending = { address, block, line: block % CACHE_LINES, tag: Math.floor(block / CACHE_LINES),
    offset: address % BLOCK_SIZE, phase: "fetch", value: null, hit: false };
  elements.journeyEmpty.hidden = false;
  elements.journeyResult.hidden = true;
  elements.addressBadge.textContent = "AWAITING DECODE";
  setManualBusy(true);
  setCycleStage("fetch", `CPU requests address ${formatAddress(address)} (${address.toString(2).padStart(16, "0")}). Next, split it into tag, index, and offset.`);
});

document.querySelectorAll(".example").forEach(button => {
  button.addEventListener("click", () => {
    elements.address.value = button.id === "random-address"
      ? Math.floor(Math.random() * MEMORY_SIZE)
      : button.dataset.address;
    updateAddressPreview();
    elements.form.requestSubmit();
  });
});
elements.address.addEventListener("input", updateAddressPreview);
elements.reset.addEventListener("click", () => resetCache(true));
elements.empty.addEventListener("click", () => resetCache(false));
document.querySelector("#program-clear").addEventListener("click", () => resetCache(false));
elements.programSelect.addEventListener("change", () => resetCache(true));
elements.nextStage.addEventListener("click", nextManualStage);
elements.loadedOnly.addEventListener("change", () => {
  render();
  if (pending) scrollToLine(pending.line);
  else if (lastLine !== null) scrollToLine(lastLine);
});
elements.programStep.addEventListener("click", () => stepProgram());
function runProgram(onePass) {
  const startingPasses = cpu.passes.length;
  let count = 0;
  while (!cpu.halted && (!onePass || cpu.passes.length === startingPasses) && count < MAX_RUN_READS) {
    stepProgram(false);
    count += 1;
  }
  if (!cpu.halted && count === MAX_RUN_READS) {
    cpu.halted = true;
    cpu.event = `Stopped after ${MAX_RUN_READS} reads: the program did not finish within the safety limit.`;
  }
  if (lastAccess) renderLastAccess();
  setCycleStage(null, "The assembly program performs CPU reads directly. See the latest read in Anatomy of an access and Access history; use manual lookup to step through the cache-check stages.");
  renderProgram();
}
elements.programPass.addEventListener("click", () => runProgram(true));
elements.programRun.addEventListener("click", () => runProgram(false));

resetCache();
