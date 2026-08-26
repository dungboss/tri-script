#target photoshop

'use strict';

// Tham số truyền từ osascript (`do javascript ... with arguments {...}`).
// PHẢI đọc ở scope script: bên trong function, `arguments` là của chính function đó.
var SCRIPT_ARGS = null;
try { SCRIPT_ARGS = arguments; } catch (e) {}

app.preferences.rulerUnits = Units.PIXELS;

var baseFolder = (new File($.fileName)).parent;
var outputFolder = new Folder(baseFolder.fsName + "/Result");

// Chế độ headless: có file config → chạy thẳng, không mở dialog (dành cho AI agent / CLI).
var configFile = getConfigFile();
var isHeadless = configFile !== null;
var logFile = new File(baseFolder.fsName + "/tri-run.log");
// Photoshop vẫn mở sau khi script xong nên tiến trình gọi không biết lúc nào kết thúc.
// Script xoá file này lúc bắt đầu và ghi lại lúc xong → bên ngoài chỉ cần poll nó.
var doneFile = new File(baseFolder.fsName + "/tri-run.done");

// Nguồn dữ liệu chọn được trong dialog. Mỗi nguồn có 2 kiểu lấy dữ liệu:
//   - file CSV nằm cạnh script (mặc định, không cần mạng)
//   - URL Google Sheets (luôn lấy bản mới nhất, cần mạng + sheet để Anyone with link)
// Trong dialog: gõ/Browse file CSV, hoặc dán thẳng URL sheet vào ô đường dẫn.
// Headless: key "source" trong config nhận cả hai kiểu, tự nhận biết bằng tiền tố http.
var DATA_SOURCES = [
  {
    label: "Pháp",
    defaultFileName: "fr_name.csv",
    defaultSheetUrl: "https://docs.google.com/spreadsheets/d/1kVWACY3JnfUmF37FaQLjRrwysCKRH14uQRh73EpY6cM/edit?gid=0#gid=0"
  },
  {
    label: "Đức",
    defaultFileName: "de_name.csv",
    defaultSheetUrl: "https://docs.google.com/spreadsheets/d/10B0orImwHdhs8pe51LXYVXS5Z2WuJtayN4WKXNkDKiE/edit?gid=0#gid=0"
  }
];

// Công thức đặt tên file output. Token trong ngoặc vuông được thay bằng giá trị của dòng;
// mọi ký tự khác giữ nguyên (phần "xxx" là chỗ người dùng tự gõ, dài ngắn tùy ý).
var DEFAULT_OUTPUT_FORMULA = "[[name]][name]-xxx-[stt]";

// Dòng dữ liệu giả, chỉ dùng để xem trước tên file trong dialog
var SAMPLE_RECORD = { sourceName: "Adam", stt: "2", content: "A-Achtsam, D-Dankbar" };

var exportOptions = new ExportOptionsSaveForWeb();
exportOptions.quality = 100;
exportOptions.PNG8 = false;
exportOptions.format = SaveDocumentType.PNG;

runMain();

// Headless không được để lỗi nổi lên thành hộp thoại — bắt hết, ghi log, rồi báo xong
function runMain() {
  if (!isHeadless) {
    app.bringToFront();
    main();
    return;
  }

  var status = "OK";
  try {
    if (main() === false) {
      status = "ERROR";
    }
  } catch (e) {
    status = "ERROR";
    log("LỖI: " + e.message + (e.line ? " (dòng " + e.line + ")" : ""));
    // lỗi giữa chừng có thể để lại template đang mở → đóng cho sạch
    closeOpenTemplate();
  }
  writeDoneFile(status);
}

function writeDoneFile(status) {
  try {
    doneFile.encoding = "UTF-8";
    doneFile.lineFeed = "Unix";
    if (doneFile.open("w")) {
      doneFile.writeln(status);
      doneFile.close();
    }
  } catch (e) {}
}

function main() {
  if (isHeadless) {
    // Không cho Photoshop bật bất kỳ hộp thoại nào — agent không click được
    app.displayDialogs = DialogModes.NO;
    resetLog();
    try { if (doneFile.exists) { doneFile.remove(); } } catch (e) {}
  }

  var selection = isHeadless ? loadHeadlessSelection(configFile) : showSelectionDialog();
  if (!selection) {
    // Headless: config lỗi. Có dialog: người dùng bấm Cancel — không phải lỗi.
    return !isHeadless;
  }

  if (selection.outputFolder) {
    outputFolder = selection.outputFolder;
  }
  if (!outputFolder.exists && !outputFolder.create()) {
    notify("Không tạo được thư mục output: " + outputFolder.fsName);
    return false;
  }
  log("Output: " + outputFolder.fsName + " | công thức: " + selection.outputFormula);

  var records = loadRecordsFromSource(selection.source);
  if (records.length === 0) {
    notify("Không tìm thấy dữ liệu hợp lệ trong nguồn \"" + selection.source.describe() + "\".");
    return false;
  }

  sortRecordsByLength(records);

  // limit > 0 → chỉ chạy vài dòng đầu, dùng để smoke test trước khi chạy full
  if (selection.limit > 0 && records.length > selection.limit) {
    log("Giới hạn " + selection.limit + "/" + records.length + " dòng (limit trong config)");
    records = records.slice(0, selection.limit);
  }
  log("Sẽ xử lý " + records.length + " dòng");

  var skippedCount = 0;
  var exported = 0;
  for (var recordIndex = 0; recordIndex < records.length; recordIndex++) {
    var record = records[recordIndex];
    var template = getTemplateForName(record.sourceName, selection.rules);
    if (!template) {
      skippedCount++;
      continue;
    }
    var outputName = applyOutputNameFormula(selection.outputFormula, record);
    processName(record.sourceName, outputName, template);
    exported++;
  }
  closeOpenTemplate();

  var summary = "Đã xuất " + exported + " ảnh.";
  if (skippedCount > 0) {
    summary += "\n" + skippedCount + " tên không khớp length rule nào.";
  }
  notify(summary);
  return true;
}

// ---------------------------------------------------------------------------
// Nguồn dữ liệu — file CSV hoặc Google Sheets, dùng chung một interface
// ---------------------------------------------------------------------------

// Nguồn dạng URL http(s) → Google Sheets; còn lại → file CSV trên đĩa
function makeSource(label, value) {
  var raw = trimString(String(value));
  var isUrl = /^https?:\/\//i.test(raw);
  return {
    label: label,
    raw: raw,
    isUrl: isUrl,
    file: isUrl ? null : new File(resolveConfigPath(raw)),
    describe: function () { return this.isUrl ? this.raw : this.file.fsName; }
  };
}

function loadRecordsFromSource(source) {
  if (source.isUrl) {
    return loadRecordsFromSheets(source);
  }
  if (!source.file || !source.file.exists) {
    notify("Không tìm thấy file CSV: " + (source.file ? source.file.fsName : source.raw));
    return [];
  }
  log("Nguồn: file CSV " + source.file.fsName);
  return loadInputRecords(source.file);
}

// Google Sheets: đổi URL edit thành URL export CSV rồi tải bằng curl
function sheetsUrlToExportUrl(url) {
  var idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) {
    return null;
  }
  var sheetId = idMatch[1];
  // gid của tab lấy ngay trong URL đã nhập (.../edit#gid=<số>); không có → tab đầu tiên
  var gidMatch = url.match(/[?&#]gid=(\d+)/);
  var gid = gidMatch ? gidMatch[1] : "0";
  return "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=csv&gid=" + gid;
}

function loadRecordsFromSheets(source) {
  var exportUrl = sheetsUrlToExportUrl(source.raw);
  if (!exportUrl) {
    notify("URL sheet \"" + source.label + "\" không hợp lệ: " + source.raw);
    return [];
  }
  log("Nguồn: Google Sheets " + exportUrl);

  var tempFile = new File(Folder.temp.fsName + "/tri_sheets_input_tmp.csv");
  try { if (tempFile.exists) { tempFile.remove(); } } catch (e) {}

  var curlCmd = 'curl -sSL -o "' + tempFile.fsName.replace(/"/g, '\\"') + '" "' + exportUrl + '"';
  app.system(curlCmd);

  if (!tempFile.exists) {
    notify("Không tải được dữ liệu từ sheet \"" + source.label + "\".\n" +
      "Kiểm tra mạng và quyền truy cập sheet (phải Public hoặc Anyone with link).");
    return [];
  }

  var records = loadInputRecords(tempFile);
  try { tempFile.remove(); } catch (e2) {}
  return records;
}

function loadInputRecords(fileObj) {
  fileObj.encoding = "UTF-8"; // ← sửa encoding
  if (!fileObj.open("r")) {
    notify("Không thể mở file " + fileObj.name);
    return [];
  }
  var content = fileObj.read();
  fileObj.close();

  if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
    content = content.substring(1);
  }

  // File tải về từ web bị lưu nhầm thành trang HTML thay vì CSV
  if (/^\s*(<!doctype|<html)/i.test(content)) {
    notify("File \"" + decodeURI(fileObj.name) + "\" không phải CSV (nội dung là HTML).");
    return [];
  }

  var rows = parseCsvRows(content);
  var items = [];
  var headerSkipped = false;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (isRowEmpty(row)) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    var stt = row.length > 0 ? trimString(row[0]) : ""; // cột A — số thứ tự
    var sourceName = row.length > 1 ? trimString(row[1]) : ""; // cột B — text đổ vào layer
    var cellContent = row.length > 2 ? trimString(row[2]) : ""; // cột C

    if (sourceName.length === 0) continue;

    items.push({
      sourceName: sourceName,
      stt: stt,
      content: cellContent
    });
  }
  return items;
}

function parseCsvRows(content) {
  var rows = [];
  var row = [];
  var field = "";
  var inQuotes = false;

  for (var i = 0; i < content.length; i++) {
    var ch = content.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === '\r' && i + 1 < content.length && content.charAt(i + 1) === '\n') {
        i++;
      }
      continue;
    }

    field += ch;
  }

  row.push(field);
  rows.push(row);
  return rows;
}

function isRowEmpty(row) {
  if (!row) {
    return true;
  }

  for (var i = 0; i < row.length; i++) {
    if (trimString(row[i]).length > 0) {
      return false;
    }
  }
  return true;
}

function sortRecordsByLength(records) {
  records.sort(function (a, b) {
    var aLength = getNameLength(a.sourceName);
    var bLength = getNameLength(b.sourceName);

    if (aLength < bLength) {
      return -1;
    }
    if (aLength > bLength) {
      return 1;
    }

    var aName = String(a.sourceName).toLowerCase();
    var bName = String(b.sourceName).toLowerCase();
    if (aName < bName) {
      return -1;
    }
    if (aName > bName) {
      return 1;
    }

    var aStt = String(a.stt).toLowerCase();
    var bStt = String(b.stt).toLowerCase();
    if (aStt < bStt) {
      return -1;
    }
    if (aStt > bStt) {
      return 1;
    }

    return 0;
  });
}

// ---------------------------------------------------------------------------
// Headless mode — cấu hình bằng file JSON thay cho dialog
// ---------------------------------------------------------------------------

// Thứ tự ưu tiên: tham số osascript (`with arguments`) → biến môi trường TRI_CONFIG
// → ./tri-config.json. Photoshop đang chạy sẵn KHÔNG thấy env của shell, nên tham số
// osascript là cách đáng tin cậy nhất khi gọi từ agent/CLI.
function getConfigFile() {
  var scriptFolder = (new File($.fileName)).parent;
  var candidates = [];

  if (SCRIPT_ARGS && SCRIPT_ARGS.length > 0 && SCRIPT_ARGS[0]) {
    candidates.push(String(SCRIPT_ARGS[0]));
  }

  try {
    var envPath = $.getenv("TRI_CONFIG");
    if (envPath) {
      candidates.push(envPath);
    }
  } catch (e2) {}

  // Windows: `Photoshop.exe -r script.jsx` không truyền được tham số, nên run-tri.bat
  // ghi đường dẫn config vào file trỏ này. Script xoá file trỏ ngay sau khi đọc.
  var pointerFile = new File(scriptFolder.fsName + "/tri-config-path.txt");
  if (pointerFile.exists) {
    pointerFile.encoding = "UTF-8";
    if (pointerFile.open("r")) {
      var pointed = trimString(pointerFile.read());
      pointerFile.close();
      if (pointed.length > 0) {
        candidates.push(pointed);
      }
    }
    try { pointerFile.remove(); } catch (e3) {}
  }

  candidates.push(scriptFolder.fsName + "/tri-config.json");

  for (var i = 0; i < candidates.length; i++) {
    var path = trimString(candidates[i]);
    if (path.length === 0) {
      continue;
    }
    var file = new File(path);
    if (file.exists) {
      return file;
    }
  }
  return null;
}

function loadHeadlessSelection(fileObj) {
  var config = readJsonFile(fileObj);
  if (!config) {
    return null;
  }
  log("Config: " + fileObj.fsName);

  if (!config.source) {
    notify("Config thiếu key \"source\" (đường dẫn file CSV hoặc URL Google Sheets).");
    return null;
  }
  var source = makeSource(config.sourceLabel || "config", config.source);

  var templateFolder = config.templateFolder
    ? new Folder(resolveConfigPath(config.templateFolder))
    : getDefaultTemplateFolder();
  if (!templateFolder || !templateFolder.exists) {
    notify("Không tìm thấy templateFolder: " + config.templateFolder);
    return null;
  }
  log("Template: " + templateFolder.fsName);

  var templateFiles = loadTemplateFiles(templateFolder);
  if (templateFiles.length === 0) {
    notify("Không có file .psd nào trong " + templateFolder.fsName);
    return null;
  }

  var rules = buildHeadlessRules(config.rules, templateFolder, templateFiles);
  if (!rules) {
    return null;
  }

  var outFolder = config.outputFolder
    ? new Folder(resolveConfigPath(config.outputFolder))
    : null;

  var limit = 0;
  if (config.limit !== undefined && config.limit !== null) {
    limit = parseInt(config.limit, 10);
    if (isNaN(limit) || limit < 0) {
      notify("Config có \"limit\" không hợp lệ: " + config.limit);
      return null;
    }
  }

  return {
    source: source,
    outputFormula: trimString(config.outputFormula || DEFAULT_OUTPUT_FORMULA),
    outputFolder: outFolder,
    rules: rules,
    limit: limit
  };
}

// rules trong config: [{ "min": 3, "max": 5, "template": "abc.psd" }, ...]
// max bỏ trống / null = không giới hạn trên. template là tên file trong templateFolder
// hoặc đường dẫn đầy đủ.
function buildHeadlessRules(rulesConfig, templateFolder, templateFiles) {
  if (!rulesConfig || !rulesConfig.length) {
    notify("Config thiếu \"rules\" — cần ít nhất 1 rule { min, max, template }.");
    return null;
  }

  var rules = [];
  for (var i = 0; i < rulesConfig.length; i++) {
    var entry = rulesConfig[i];
    var label = "rule " + (i + 1);

    var minValue = parseInt(entry.min, 10);
    if (isNaN(minValue)) {
      notify(label + ": \"min\" không hợp lệ.");
      return null;
    }

    var maxValue = null;
    if (entry.max !== undefined && entry.max !== null && trimString(String(entry.max)).length > 0) {
      maxValue = parseInt(entry.max, 10);
      if (isNaN(maxValue)) {
        notify(label + ": \"max\" không hợp lệ (bỏ trống = không giới hạn).");
        return null;
      }
      if (maxValue < minValue) {
        notify(label + ": \"max\" phải >= \"min\".");
        return null;
      }
    }

    if (!entry.template) {
      notify(label + ": thiếu \"template\".");
      return null;
    }

    // Tên file trần được hiểu là nằm trong templateFolder
    var entryPath = trimString(String(entry.template));
    var templateFile = /[\/\\]/.test(entryPath)
      ? new File(resolveConfigPath(entryPath))
      : new File(templateFolder.fsName + "/" + entryPath);

    if (!templateFile.exists) {
      var matched = findTemplateIndexByName(templateFiles, entryPath);
      if (matched < 0) {
        notify(label + ": không tìm thấy template \"" + entry.template + "\".");
        return null;
      }
      templateFile = templateFiles[matched];
    }

    rules.push({ min: minValue, max: maxValue, template: templateFile });
  }

  sortRulesByRange(rules);
  if (!validateRulesHeadless(rules)) {
    return null;
  }
  return rules;
}

// validateRules() gốc dùng alert() nên headless sẽ treo — bản này báo qua log
function validateRulesHeadless(rules) {
  for (var i = 1; i < rules.length; i++) {
    var prev = rules[i - 1];
    var current = rules[i];
    if (prev.max === null) {
      notify("Rule để trống max phải nằm cuối cùng.");
      return false;
    }
    if (current.min <= prev.max) {
      notify("Các rule bị chồng khoảng: " + prev.min + "-" + prev.max +
        " và " + current.min + "-" + (current.max === null ? "∞" : current.max));
      return false;
    }
  }
  return true;
}

function readJsonFile(fileObj) {
  fileObj.encoding = "UTF-8";
  if (!fileObj.open("r")) {
    notify("Không mở được config " + fileObj.fsName);
    return null;
  }
  var content = fileObj.read();
  fileObj.close();

  if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
    content = content.substring(1);
  }

  try {
    return eval("(" + content + ")");
  } catch (e) {
    notify("Config không phải JSON hợp lệ: " + e.message);
    return null;
  }
}

// Đường dẫn tương đối trong config được hiểu là tương đối so với thư mục chứa script
function resolveConfigPath(path) {
  path = trimString(String(path));
  // Tuyệt đối: /unix, ~/home, C:\windows, C:/windows, \\máy-chủ\chia-sẻ
  if (/^([~\/]|[A-Za-z]:|\\\\)/.test(path)) {
    return path;
  }
  return baseFolder.fsName + "/" + path;
}

// Headless thì alert() sẽ treo script → ghi log ra file + stdout
function notify(message) {
  if (isHeadless) {
    log(message);
    return;
  }
  alert(message);
}

function log(message) {
  try { $.writeln(message); } catch (e) {}
  if (!isHeadless) {
    return;
  }
  try {
    logFile.encoding = "UTF-8";
    logFile.lineFeed = "Unix";
    if (logFile.open("a")) {
      logFile.writeln(message);
      logFile.close();
    }
  } catch (e2) {}
}

function resetLog() {
  try {
    logFile.encoding = "UTF-8";
    logFile.lineFeed = "Unix";
    if (logFile.open("w")) {
      logFile.writeln("[" + (new Date()).toString() + "] tri script bắt đầu");
      logFile.close();
    }
  } catch (e) {}
}

function showSelectionDialog() {
  var dialog = new Window("dialog", "Chọn nguồn dữ liệu và thư mục template");
  dialog.orientation = "column";
  dialog.alignChildren = "fill";
  dialog.spacing = 10;
  dialog.margins = 16;

  var message = dialog.add("statictext", undefined, "Tick chọn nguồn cần chạy (file CSV hoặc URL Google Sheets), chọn thư mục template, và cấu hình length rules.");
  message.maximumSize.width = 420;

  // Mỗi nguồn 1 dòng: radio chọn + đường dẫn file CSV riêng
  var csvPanel = dialog.add("panel", undefined, "Nguồn dữ liệu");
  csvPanel.orientation = "column";
  csvPanel.alignChildren = "fill";
  csvPanel.spacing = 8;
  csvPanel.margins = 10;

  var csvRows = [];
  for (var si = 0; si < DATA_SOURCES.length; si++) {
    csvRows.push(addCsvSourceRow(csvPanel, csvRows, DATA_SOURCES[si], si === 0));
  }

  // Công thức đặt tên file output — sửa được toàn bộ, kèm ô xem trước cập nhật ngay khi gõ
  var formulaPanel = dialog.add("panel", undefined, "Tên file output");
  formulaPanel.orientation = "column";
  formulaPanel.alignChildren = "fill";
  formulaPanel.spacing = 6;
  formulaPanel.margins = 10;

  var formulaRow = formulaPanel.add("group");
  formulaRow.orientation = "row";
  formulaRow.alignChildren = ["left", "center"];
  formulaRow.spacing = 10;
  formulaRow.add("statictext", undefined, "Công thức:");
  var formulaField = formulaRow.add("edittext", undefined, DEFAULT_OUTPUT_FORMULA);
  formulaField.preferredSize.width = 380;

  var formulaHint = formulaPanel.add("statictext", undefined,
    "Token: [name] = cột name, [stt] = cột số thứ tự, [content] = cột content. Chữ khác giữ nguyên.");
  formulaHint.maximumSize.width = 460;

  var formulaPreview = formulaPanel.add("statictext", undefined, "");
  formulaPreview.maximumSize.width = 460;

  function refreshFormulaPreview() {
    formulaPreview.text = "Ví dụ: " + buildOutputFileName(
      applyOutputNameFormula(formulaField.text, SAMPLE_RECORD)
    );
  }
  formulaField.onChanging = refreshFormulaPreview;
  refreshFormulaPreview();

  var templateFolderRow = addPathPickerRow(dialog, "Template folder", "folder");

  var defaultTemplateFolder = getDefaultTemplateFolder();
  if (defaultTemplateFolder) {
    templateFolderRow.value = defaultTemplateFolder;
    templateFolderRow.pathField.text = defaultTemplateFolder.fsName;
  }

  var rulePanel = dialog.add("panel", undefined, "Length rules");
  rulePanel.orientation = "column";
  rulePanel.alignChildren = "fill";
  rulePanel.spacing = 8;
  rulePanel.margins = 10;

  var ruleNote = rulePanel.add("statictext", undefined, "Use Min/Max. Leave Max blank for open-ended.");
  ruleNote.maximumSize.width = 420;

  var ruleList = rulePanel.add("group");
  ruleList.orientation = "column";
  ruleList.alignChildren = "fill";
  ruleList.spacing = 6;

  var ruleRows = [];
  var currentTemplateFiles = [];
  if (defaultTemplateFolder.exists) {
    currentTemplateFiles = loadTemplateFiles(defaultTemplateFolder);
  }

  // Mỗi độ dài ký tự (3..11) tương ứng đúng 1 template
  var defaultRules = [];
  for (var len = 3; len <= 11; len++) {
    defaultRules.push({ min: len, max: len, length: len });
  }
  for (var ri = 0; ri < defaultRules.length; ri++) {
    ruleRows.push(addRuleRow(ruleList, ruleRows, defaultRules[ri], currentTemplateFiles));
  }

  var ruleButtonRow = rulePanel.add("group");
  ruleButtonRow.alignment = "right";
  var addRuleButton = ruleButtonRow.add("button", undefined, "Add rule");

  addRuleButton.onClick = function () {
    ruleRows.push(addRuleRow(ruleList, ruleRows, null, currentTemplateFiles));
    dialog.layout.layout(true);
  };

  templateFolderRow.browseButton.onClick = function () {
    var folder = Folder.selectDialog("Select the template folder");
    if (!folder) {
      return;
    }
    templateFolderRow.value = folder;
    templateFolderRow.pathField.text = folder.fsName;

    currentTemplateFiles = loadTemplateFiles(folder);
    if (currentTemplateFiles.length === 0) {
      alert("No PSD files were found in the selected folder.");
      templateFolderRow.value = null;
      templateFolderRow.pathField.text = "";
      populateRuleRowsTemplateFiles(ruleRows, currentTemplateFiles);
      dialog.layout.layout(true);
      return;
    }
    populateRuleRowsTemplateFiles(ruleRows, currentTemplateFiles);
    dialog.layout.layout(true);
  };

  var buttonGroup = dialog.add("group");
  buttonGroup.alignment = "right";
  var okButton = buttonGroup.add("button", undefined, "OK", { name: "ok" });
  var cancelButton = buttonGroup.add("button", undefined, "Cancel", { name: "cancel" });

  okButton.onClick = function () {
    dialog.close(1);
  };
  cancelButton.onClick = function () {
    dialog.close(0);
  };

  if (dialog.show() != 1) {
    return null;
  }

  var selectedSource = getSelectedCsvSource(csvRows);
  if (!selectedSource) {
    alert("Vui lòng chọn 1 nguồn dữ liệu và điền đường dẫn CSV hoặc URL sheet.");
    return null;
  }

  if (!selectedSource.isUrl && !selectedSource.file.exists) {
    alert("Không tìm thấy file CSV:\n" + selectedSource.file.fsName);
    return null;
  }

  var outputFormula = trimString(formulaField.text);
  if (outputFormula.length === 0) {
    alert("Vui lòng nhập công thức tên file output.");
    return null;
  }

  // Không có token nào → mọi dòng ra cùng 1 tên file và đè lên nhau
  if (!/\[(name|stt|content)\]/i.test(outputFormula)) {
    if (!confirm("Công thức không chứa token nào ([name], [stt], [content]).\n" +
      "Tất cả ảnh sẽ có cùng tên file và ghi đè lên nhau.\n\nVẫn tiếp tục?")) {
      return null;
    }
  }

  if (!templateFolderRow.value) {
    alert("Vui lòng chọn thư mục template.");
    return null;
  }

  if (!templateFolderRow.value.exists) {
    alert("Template folder is not found.");
    return null;
  }

  var rules = buildRulesFromRows(ruleRows);
  if (!rules) {
    return null;
  }

  return {
    source: selectedSource,
    outputFormula: outputFormula,
    outputFolder: null,
    rules: rules,
    limit: 0
  };
}

// 1 dòng nguồn: radio chọn + đường dẫn file CSV + nút Browse riêng của nguồn đó
function addCsvSourceRow(parent, csvRows, sourceConfig, isSelected) {
  var row = parent.add("group");
  row.orientation = "row";
  row.alignChildren = ["left", "center"];
  row.spacing = 10;

  row.label = sourceConfig.label;

  row.radio = row.add("radiobutton", undefined, sourceConfig.label);
  row.radio.preferredSize.width = 70;
  row.radio.value = !!isSelected;

  // ScriptUI chỉ tự nhóm radio cùng container; mỗi dòng là 1 group riêng nên phải tự bỏ tick các dòng khác
  row.radio.onClick = function () {
    for (var i = 0; i < csvRows.length; i++) {
      if (csvRows[i] !== row) {
        csvRows[i].radio.value = false;
      }
    }
    row.radio.value = true;
  };

  // File mặc định nằm cùng thư mục với script
  var defaultFile = new File(baseFolder.fsName + "/" + sourceConfig.defaultFileName);
  row.value = defaultFile.exists ? defaultFile : null;

  // Ô này nhận CẢ đường dẫn file CSV lẫn URL Google Sheets → cho gõ/dán tay
  row.pathField = row.add("edittext", undefined, defaultFile.exists ? defaultFile.fsName : "");
  row.pathField.preferredSize.width = 300;
  row.pathField.helpTip = "Đường dẫn file CSV, hoặc dán URL Google Sheets vào đây";
  // Gõ vào dòng nào thì tự tick dòng đó
  row.pathField.onChanging = function () { row.radio.onClick(); };

  // Nút điền nhanh URL sheet mặc định của nguồn này
  row.sheetButton = row.add("button", undefined, "Sheet");
  row.sheetButton.preferredSize.width = 55;
  row.sheetButton.helpTip = "Dùng Google Sheets thay cho file CSV";
  row.sheetButton.onClick = function () {
    row.pathField.text = sourceConfig.defaultSheetUrl;
    row.radio.onClick();
  };

  row.browseButton = row.add("button", undefined, "CSV...");
  row.browseButton.onClick = function () {
    var file = File.openDialog("Chọn file CSV cho " + sourceConfig.label);
    if (!file) {
      return;
    }
    if (!isCsvFile(file)) {
      alert("Vui lòng chọn file input có định dạng .csv.");
      return;
    }
    row.pathField.text = file.fsName;

    // Chọn file cho dòng nào thì tự tick dòng đó
    row.radio.onClick();
  };

  return row;
}

// Trả về { label, file } của nguồn đang được tick, null nếu chưa chọn
function getSelectedCsvSource(csvRows) {
  for (var i = 0; i < csvRows.length; i++) {
    if (csvRows[i].radio.value) {
      var raw = trimString(csvRows[i].pathField.text);
      if (raw.length === 0) {
        return null;
      }
      return makeSource(csvRows[i].label, raw);
    }
  }
  return null;
}

function getDefaultTemplateFolder() {
  var candidateFolders = [
    new Folder(baseFolder.fsName),
    new Folder(baseFolder.fsName + "/PTS")
  ];

  for (var i = 0; i < candidateFolders.length; i++) {
    if (!candidateFolders[i].exists) {
      continue;
    }
    if (loadTemplateFiles(candidateFolders[i]).length > 0) {
      return candidateFolders[i];
    }
  }

  for (var j = 0; j < candidateFolders.length; j++) {
    if (candidateFolders[j].exists) {
      return candidateFolders[j];
    }
  }

  return candidateFolders[0];
}

function addPathPickerRow(parent, label, kind) {
  var row = parent.add("group");
  row.orientation = "row";
  row.alignChildren = ["left", "center"];
  row.spacing = 10;

  row.add("statictext", undefined, label);

  var pathField = row.add("edittext", undefined, "");
  pathField.preferredSize.width = 300;
  pathField.enabled = false;

  var browseButton = row.add("button", undefined, "Browse...");
  row.pathField = pathField;
  row.browseButton = browseButton;
  row.value = null;

  browseButton.onClick = function () {
    if (kind === "folder") {
      var folder = Folder.selectDialog("Select " + label);
      if (!folder) {
        return;
      }
      row.value = folder;
      pathField.text = folder.fsName;
      return;
    }

    var file = File.openDialog("Select " + label);
    if (!file) {
      return;
    }
    if (kind === "csv" && !isCsvFile(file)) {
      row.value = null;
      pathField.text = "";
      alert("Vui lòng chọn file input có định dạng .csv.");
      return;
    }
    row.value = file;
    pathField.text = file.fsName;
  };

  return row;
}

function addRuleRow(parent, ruleRows, defaults, templateFiles) {
  var row = parent.add("group");
  row.orientation = "row";
  row.alignChildren = ["left", "center"];
  row.spacing = 10;
  row.defaultTemplateName = defaults && defaults.templateName ? defaults.templateName : null;
  // Độ dài ký tự của rule — dùng để tự dò template theo số cuối tên file khi đổi thư mục
  row.defaultLength = defaults && defaults.length ? defaults.length : null;

  row.add("statictext", undefined, "Min");

  row.minField = row.add("edittext", undefined, defaults && defaults.min !== null && typeof defaults.min !== "undefined" ? String(defaults.min) : "");
  row.minField.preferredSize.width = 36;

  row.add("statictext", undefined, "Max");

  row.maxField = row.add("edittext", undefined, defaults && defaults.max !== null && typeof defaults.max !== "undefined" ? String(defaults.max) : "");
  row.maxField.preferredSize.width = 36;

  row.templateDropdown = row.add("dropdownlist", undefined, []);
  row.templateDropdown.preferredSize.width = 300;

  row.removeButton = row.add("button", undefined, "Remove");
  row.templateFiles = [];

  populateRuleRowTemplates(row, templateFiles || []);

  row.removeButton.onClick = function () {
    if (ruleRows.length <= 1) {
      alert("Keep at least one length rule.");
      return;
    }

    var rowIndex = -1;
    for (var i = 0; i < ruleRows.length; i++) {
      if (ruleRows[i] === row) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return;
    }

    ruleRows.splice(rowIndex, 1);
    parent.remove(row);
    parent.layout.layout(true);
  };

  return row;
}

function populateRuleRowsTemplateFiles(ruleRows, templateFiles) {
  for (var i = 0; i < ruleRows.length; i++) {
    populateRuleRowTemplates(ruleRows[i], templateFiles);
  }
}

function populateRuleRowTemplates(row, templateFiles) {
  var previousTemplateName = getSelectedTemplateName(row);
  var dropdown = row.templateDropdown;

  while (dropdown.items.length > 0) {
    dropdown.remove(0);
  }

  row.templateFiles = templateFiles || [];

  if (!templateFiles || templateFiles.length === 0) {
    dropdown.add("item", "Select template folder first");
    dropdown.selection = 0;
    dropdown.enabled = false;
    return null;
  }

  dropdown.add("item", "Select template");
  for (var i = 0; i < templateFiles.length; i++) {
    dropdown.add("item", decodeURI(templateFiles[i].name));
  }
  dropdown.enabled = true;

  // Ưu tiên: lựa chọn cũ → tên template mặc định → dò theo độ dài ký tự của rule
  var selectedIndex = 0;
  if (previousTemplateName) {
    selectedIndex = findTemplateIndexByName(templateFiles, previousTemplateName) + 1;
  }
  if (selectedIndex === 0 && row.defaultTemplateName) {
    selectedIndex = findTemplateIndexByName(templateFiles, row.defaultTemplateName) + 1;
  }
  if (selectedIndex === 0 && row.defaultLength) {
    selectedIndex = findTemplateIndexByLength(templateFiles, row.defaultLength) + 1;
  }

  dropdown.selection = selectedIndex;
}

function getSelectedTemplateName(row) {
  if (!row.templateDropdown.selection || row.templateDropdown.selection.index === 0) {
    return null;
  }
  return row.templateDropdown.selection.text;
}

function getSelectedTemplateFile(row) {
  if (!row.templateDropdown.selection || row.templateDropdown.selection.index === 0) {
    return null;
  }
  var index = row.templateDropdown.selection.index - 1;
  if (!row.templateFiles || index < 0 || index >= row.templateFiles.length) {
    return null;
  }
  return row.templateFiles[index];
}

function findTemplateIndexByName(templateFiles, templateName) {
  if (!templateFiles || !templateName) {
    return -1;
  }

  var normalizedTemplateName = normalizeTemplateName(templateName);
  for (var i = 0; i < templateFiles.length; i++) {
    if (normalizeTemplateName(templateFiles[i].name) === normalizedTemplateName) {
      return i;
    }
  }
  return -1;
}

// Dò template theo số ở cuối tên file (bỏ phần mở rộng): "LY0326002_7", "tri18 7", "7" → độ dài 7
function findTemplateIndexByLength(templateFiles, length) {
  if (!templateFiles || !length) {
    return -1;
  }

  for (var i = 0; i < templateFiles.length; i++) {
    var trailingNumber = normalizeTemplateName(templateFiles[i].name).match(/(\d+)\s*$/);
    if (trailingNumber && parseInt(trailingNumber[1], 10) === length) {
      return i;
    }
  }
  return -1;
}

function normalizeTemplateName(name) {
  name = decodeURI(String(name));
  name = trimString(name).toLowerCase();
  var dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0) {
    return name.substring(0, dotIndex);
  }
  return name;
}

function buildRulesFromRows(ruleRows) {
  var rules = [];
  for (var i = 0; i < ruleRows.length; i++) {
    var row = ruleRows[i];
    var minValue = parseLengthValue(row.minField.text, false);
    var maxValue = parseLengthValue(row.maxField.text, true);
    var templateFile = getSelectedTemplateFile(row);

    if (isNaN(minValue)) {
      alert("Invalid Min value in rule " + (i + 1) + ".");
      return null;
    }

    if (maxValue !== null && isNaN(maxValue)) {
      alert("Invalid Max value in rule " + (i + 1) + ". Leave it blank for open-ended.");
      return null;
    }

    if (maxValue !== null && maxValue < minValue) {
      alert("Max must be greater than or equal to Min in rule " + (i + 1) + ".");
      return null;
    }

    if (!templateFile) {
      alert("Please choose a template in rule " + (i + 1) + ".");
      return null;
    }

    if (!isPsdFile(templateFile)) {
      alert("Template in rule " + (i + 1) + " must be a .psd file.");
      return null;
    }

    rules.push({
      min: minValue,
      max: maxValue,
      template: templateFile
    });
  }

  sortRulesByRange(rules);
  if (!validateRules(rules)) {
    return null;
  }
  return rules;
}

function parseLengthValue(text, allowBlank) {
  text = trimString(text);
  if (text.length === 0) {
    return allowBlank ? null : NaN;
  }
  var normalized = text.replace(/\s+/g, "");

  if (allowBlank) {
    if (/^\+$/.test(normalized) || /^\d+\+$/.test(normalized)) {
      return null;
    }
    if (/^\d+$/.test(normalized)) {
      return parseInt(normalized, 10);
    }
    return NaN;
  }

  if (/^\d+$/.test(normalized)) {
    return parseInt(normalized, 10);
  }
  return NaN;
}

function trimString(value) {
  return String(value).replace(/^\s+|\s+$/g, "");
}

function isCsvFile(fileObj) {
  return !!fileObj && /\.csv$/i.test(fileObj.name);
}

function isPsdFile(fileObj) {
  return !!fileObj && /\.psd$/i.test(fileObj.name);
}

function sortRulesByRange(rules) {
  rules.sort(function (a, b) {
    if (a.min < b.min) {
      return -1;
    }
    if (a.min > b.min) {
      return 1;
    }

    var aMax = a.max === null ? 999999999 : a.max;
    var bMax = b.max === null ? 999999999 : b.max;
    if (aMax < bMax) {
      return -1;
    }
    if (aMax > bMax) {
      return 1;
    }
    return 0;
  });
}

function validateRules(rules) {
  for (var i = 0; i < rules.length - 1; i++) {
    var currentRule = rules[i];
    var nextRule = rules[i + 1];

    if (currentRule.max === null) {
      alert("Open-ended rules must be the last rule.");
      return false;
    }

    if (nextRule.min <= currentRule.max) {
      alert("Length rules overlap between rule " + (i + 1) + " and rule " + (i + 2) + ".");
      return false;
    }
  }
  return true;
}

function loadTemplateFiles(folderObj) {
  var files = folderObj.getFiles(/\.(psd)$/i);
  sortFilesByName(files);
  return files;
}

function sortFilesByName(files) {
  files.sort(function (a, b) {
    var an = decodeURI(a.name).toLowerCase();
    var bn = decodeURI(b.name).toLowerCase();
    if (an < bn) {
      return -1;
    }
    if (an > bn) {
      return 1;
    }
    return 0;
  });
}

function getTemplateForName(name, rules) {
  var length = getNameLength(name);
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (length < rule.min) {
      continue;
    }
    if (rule.max !== null && length > rule.max) {
      continue;
    }
    return rule.template;
  }
  return null;
}

function getNameLength(name) {
  name = String(name);
  name = name.replace(/^\s+|\s+$/g, "");
  return name.length;
}

// Giữ template đang mở giữa các dòng — records đã sort theo length nên các tên
// liền nhau thường dùng chung 1 template, đỡ phải open/close PSD cho từng tên
var openTemplateDoc = null;
var openTemplatePath = null;

function ensureTemplateOpen(template) {
  var path = template.fsName;

  // doc cũ còn đúng template và còn sống → tái sử dụng
  if (openTemplateDoc !== null && openTemplatePath === path) {
    try {
      app.activeDocument = openTemplateDoc;
      return openTemplateDoc;
    } catch (e) {
      // doc đã bị đóng ngoài ý muốn → mở lại bên dưới
      openTemplateDoc = null;
      openTemplatePath = null;
    }
  }

  closeOpenTemplate();
  open(template);
  openTemplateDoc = app.activeDocument;
  openTemplatePath = path;
  return openTemplateDoc;
}

function closeOpenTemplate() {
  if (openTemplateDoc === null) {
    return;
  }
  try {
    openTemplateDoc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (e) {}
  openTemplateDoc = null;
  openTemplatePath = null;
}

function processName(sourceName, outputName, template) {
  var doc = ensureTemplateOpen(template);

  var nameLayers = findAllLayersByName(doc, "name");
  for (var nl = 0; nl < nameLayers.length; nl++) {
    changeLayerContent(nameLayers[nl], sourceName);
  }

  var firstLetterLayers = findAllLayersByName(doc, "first_letter");
  var firstLetter = trimString(String(sourceName)).charAt(0);
  for (var fl = 0; fl < firstLetterLayers.length; fl++) {
    changeLayerContent(firstLetterLayers[fl], firstLetter);
  }

  var outputFileName = buildOutputFileName(outputName);
  app.activeDocument.exportDocument(
    new File(outputFolder.fsName + "/" + outputFileName),
    ExportType.SAVEFORWEB,
    exportOptions
  );
}

// Focus name layer → enter text edit mode → paste new content (mirrors manual double-click + paste)
function changeLayerContent(nameLayer, sourceName) {
  if (!nameLayer) {
    return;
  }

  // Step 1: focus layer (equivalent to clicking the layer in Layers panel)
  app.activeDocument.activeLayer = nameLayer;

  // Step 2: enter text edit mode (equivalent to double-clicking the layer)
  var selectDesc = new ActionDescriptor();
  var selectRef = new ActionReference();
  selectRef.putEnumerated(charIDToTypeID("TxLr"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
  selectDesc.putReference(charIDToTypeID("null"), selectRef);
  executeAction(charIDToTypeID("slct"), selectDesc, DialogModes.NO);

  // Step 3: paste new content — replaces all text, preserves layer formatting
  nameLayer.textItem.contents = trimString(String(sourceName));
}

// Thay token [name] / [stt] / [content] trong công thức bằng giá trị của dòng.
// Không phân biệt hoa thường; ký tự còn lại trong công thức giữ nguyên.
function applyOutputNameFormula(formula, record) {
  var result = String(formula)
    .replace(/\[name\]/gi, String(record.sourceName))
    .replace(/\[stt\]/gi, String(record.stt))
    .replace(/\[content\]/gi, String(record.content));

  // Công thức rỗng hoặc chỉ chứa token rỗng → lùi về tên gốc để không mất file
  if (trimString(result).length === 0) {
    return record.sourceName;
  }
  return result;
}

function sanitizeFileName(name) {
  return name.replace(/[\\\/:\*\?"<>\|]/g, "_");
}

function buildOutputFileName(outputName) {
  var fileName = sanitizeFileName(trimString(outputName)).replace(/[\. ]+$/g, "");
  if (fileName.length === 0) {
    fileName = "output";
  }
  if (!/\.png$/i.test(fileName)) {
    fileName += ".png";
  }
  return fileName;
}

function findLayers(searchFolder, recursion, userData, items) {
  items = items || [];
  var folderItem;
  for (var i = 0; i < searchFolder.layers.length; i++) {
    folderItem = searchFolder.layers[i];
    if (propertiesMatch(folderItem, userData)) {
      items.push(folderItem);
    }
    if (recursion === true && folderItem.typename === "LayerSet") {
      findLayers(folderItem, recursion, userData, items);
    }
  }
  return items;
}

function propertiesMatch(projectItem, userData) {
  if (typeof userData === "undefined") return true;
  for (var propertyName in userData) {
    if (!userData.hasOwnProperty(propertyName)) continue;
    if (!projectItem.hasOwnProperty(propertyName)) return false;
    if (projectItem[propertyName].toString() !== userData[propertyName].toString()) {
      return false;
    }
  }
  return true;
}

function findLayerByName(doc, name) {
  var results = findLayers(doc, true, { name: name });
  return results.length > 0 ? results[0] : null;
}

function findAllLayersByName(doc, name) {
  return findLayers(doc, true, { name: name });
}


