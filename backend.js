const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const AfricasTalking = require('africastalking');
const { sendSOSAlerts } = require('./sos-alerts');
const ussdHandler = require('./lib/ussd-handler');

const app = express();
const PORT = 8000;
const DATA_DIR = path.join(__dirname, 'data');

// Initialize Africa's Talking for SMS
const atCredentials = {
  apiKey: process.env.AT_API_KEY || 'YOUR_API_KEY_HERE',
  username: process.env.AT_USERNAME || 'sandbox',
};
const africastalking = AfricasTalking(atCredentials);
const sms = africastalking.SMS;

// Enable CORS for API flexibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// In-memory patient storage
const patients = new Map();
const readings = [];

// Medication management storage
const medications = new Map(); // phoneNumber -> [medication objects]
const adherenceLog = []; // array of adherence records

// Emergency & SOS storage
const emergencyContacts = new Map(); // phoneNumber -> [contact objects]
const sosEvents = []; // array of SOS event records

// Helper function to generate unique IDs
let medicationIdCounter = 1;
let sosEventIdCounter = 1;
const generateMedicationId = () => `MED${medicationIdCounter++}`;
const generateSosEventId = () => `SOS${sosEventIdCounter++}`;

// ===============================================
// JSON FILE STORAGE SYSTEM
// ===============================================

// Helper to convert Map to array for JSON storage
const mapToArray = (map) => Array.from(map.entries());
const arrayToMap = (arr) => new Map(arr || []);

// File paths
const FILES = {
  patients: path.join(DATA_DIR, 'patients.json'),
  readings: path.join(DATA_DIR, 'readings.json'),
  medications: path.join(DATA_DIR, 'medications.json'),
  adherence: path.join(DATA_DIR, 'adherence.json'),
  emergencyContacts: path.join(DATA_DIR, 'emergency-contacts.json'),
  sosEvents: path.join(DATA_DIR, 'sos-events.json'),
  counters: path.join(DATA_DIR, 'counters.json'),
};

// Load data from JSON files
async function loadData() {
  console.log('Loading data from files...');

  try {
    // Ensure data directory exists
    await fs.mkdir(DATA_DIR, { recursive: true });

    // Load patients
    try {
      const patientsData = await fs.readFile(FILES.patients, 'utf8');
      const patientsArray = JSON.parse(patientsData);
      patients.clear();
      patientsArray.forEach(([key, value]) => patients.set(key, value));
      console.log(`Loaded ${patients.size} patients`);
    } catch (err) {
      console.log('No existing patients data');
    }

    // Load readings
    try {
      const readingsData = await fs.readFile(FILES.readings, 'utf8');
      const loadedReadings = JSON.parse(readingsData);
      readings.length = 0;
      readings.push(...loadedReadings);
      console.log(`Loaded ${readings.length} readings`);
    } catch (err) {
      console.log('No existing readings data');
    }

    // Load medications
    try {
      const medicationsData = await fs.readFile(FILES.medications, 'utf8');
      const medicationsArray = JSON.parse(medicationsData);
      medications.clear();
      medicationsArray.forEach(([key, value]) => medications.set(key, value));
      console.log(`Loaded ${medications.size} medication records`);
    } catch (err) {
      console.log('No existing medications data');
    }

    // Load adherence log
    try {
      const adherenceData = await fs.readFile(FILES.adherence, 'utf8');
      const loadedAdherence = JSON.parse(adherenceData);
      adherenceLog.length = 0;
      adherenceLog.push(...loadedAdherence);
      console.log(`Loaded ${adherenceLog.length} adherence records`);
    } catch (err) {
      console.log('No existing adherence data');
    }

    // Load emergency contacts
    try {
      const contactsData = await fs.readFile(FILES.emergencyContacts, 'utf8');
      const contactsArray = JSON.parse(contactsData);
      emergencyContacts.clear();
      contactsArray.forEach(([key, value]) => emergencyContacts.set(key, value));
      console.log(`Loaded ${emergencyContacts.size} emergency contact records`);
    } catch (err) {
      console.log('No existing emergency contacts data');
    }

    // Load SOS events
    try {
      const sosData = await fs.readFile(FILES.sosEvents, 'utf8');
      const loadedSos = JSON.parse(sosData);
      sosEvents.length = 0;
      sosEvents.push(...loadedSos);
      console.log(`Loaded ${sosEvents.length} SOS events`);
    } catch (err) {
      console.log('No existing SOS events data');
    }

    // Load ID counters
    try {
      const countersData = await fs.readFile(FILES.counters, 'utf8');
      const counters = JSON.parse(countersData);
      medicationIdCounter = counters.medicationIdCounter || 1;
      sosEventIdCounter = counters.sosEventIdCounter || 1;
      console.log('Loaded ID counters');
    } catch (err) {
      console.log('No existing counters data');
    }

    console.log('Data loading complete!');
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

// Save data to JSON files
async function saveData() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });

    await Promise.all([
      fs.writeFile(FILES.patients, JSON.stringify(mapToArray(patients), null, 2)),
      fs.writeFile(FILES.readings, JSON.stringify(readings, null, 2)),
      fs.writeFile(FILES.medications, JSON.stringify(mapToArray(medications), null, 2)),
      fs.writeFile(FILES.adherence, JSON.stringify(adherenceLog, null, 2)),
      fs.writeFile(FILES.emergencyContacts, JSON.stringify(mapToArray(emergencyContacts), null, 2)),
      fs.writeFile(FILES.sosEvents, JSON.stringify(sosEvents, null, 2)),
      fs.writeFile(FILES.counters, JSON.stringify({ medicationIdCounter, sosEventIdCounter }, null, 2)),
    ]);

    console.log('Data saved successfully');
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Auto-save after modifications (debounced)
let saveTimeout;
function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveData(), 1000); // Save 1 second after last change
}

// Helper to detect if request is direct USSD from Africa's Talking or JSON from ignite.js
function isDirectUSSDRequest(reqBody) {
  const { sessionId, serviceCode, networkCode, text } = reqBody;

  // Direct USSD requests have these fields and text is not JSON
  if (!sessionId || !serviceCode || !networkCode) return false;

  // Check if text is JSON (from ignite.js) or raw USSD input
  const textStr = String(text || '').trim();
  if (!textStr) return true; // Empty text is raw USSD

  try {
    const parsed = JSON.parse(textStr);
    return !parsed.event; // If it has 'event' field, it's from ignite.js
  } catch {
    return true; // Not JSON = raw USSD
  }
}

app.post('/ussd', async (req, res) => {
  console.log('--- BACKEND REQUEST ---');
  console.log(JSON.stringify(req.body, null, 2));

  const { text } = req.body;

  // Route 1: Direct USSD from Africa's Talking
  if (isDirectUSSDRequest(req.body)) {
    console.log('Routing to direct USSD handler');
    return ussdHandler.handleDirectUSSD(req, res, {
      patients,
      readings,
      medications,
      adherenceLog,
      emergencyContacts,
      sosEvents
    });
  }

  // Route 2: JSON events from ignite.js (existing logic)
  console.log('Routing to JSON event handler');
  try {
    const data = JSON.parse(text);
    const { event, patient, reading } = data;

    if (event === 'patient_lookup') {
      const existingPatient = patients.get(patient.phoneNumber);
      if (existingPatient) {
        console.log('Patient found:', existingPatient);
        res.send(JSON.stringify({ patient: existingPatient }));
      } else {
        console.log('Patient not found');
        res.send('Patient not found');
      }
    } else if (event === 'patient_registered') {
      patients.set(patient.phoneNumber, patient);
      console.log('Patient registered:', patient);
      scheduleSave(); // Save to file

      // Send welcome SMS to new patient
      sendWelcomeSMS(patient.phoneNumber, patient.phoneNumber).catch(err => {
        console.error('Error sending welcome SMS:', err);
      });

      res.send('END Patient registered successfully');
    } else if (event === 'reading_saved') {
      readings.push(reading);
      console.log('Reading saved:', reading);
      scheduleSave(); // Save to file
      res.send('END Reading saved successfully');
    } else {
      res.send('Unknown event');
    }
  } catch (error) {
    console.error('Error:', error.message);
    res.send('END Error processing request');
  }
});

// Admin Dashboard - HTML View
app.get('/', (req, res) => {
  const patientsArray = Array.from(patients.values());

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Sickly Ignite Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" sizes="96x96" href="/icons/icons-96.png">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --success-gradient: linear-gradient(135deg, #10b981 0%, #059669 100%);
      --warning-gradient: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      --info-gradient: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      --sidebar-width: 240px;
      --header-height: 64px;
      --border-radius: 12px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.1);
      --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
      --spacing-sm: 8px;
      --spacing-md: 16px;
      --spacing-lg: 24px;
      --color-text-primary: #1f2937;
      --color-text-secondary: #6b7280;
      --color-bg: #f9fafb;
      --color-surface: #ffffff;
      --color-border: #e5e7eb;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--color-bg);
      color: var(--color-text-primary);
      overflow-x: hidden;
    }

    /* Sidebar */
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      width: var(--sidebar-width);
      height: 100vh;
      background: var(--color-surface);
      box-shadow: var(--shadow-md);
      z-index: 100;
      display: flex;
      flex-direction: column;
      padding: var(--spacing-lg) 0;
    }

    .sidebar-header {
      padding: 0 var(--spacing-lg);
      margin-bottom: var(--spacing-lg);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sidebar-title {
      font-size: 20px;
      font-weight: 700;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .sidebar-logo {
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      border-radius: 6px;
    }

    .notification-bell {
      position: relative;
      font-size: 24px;
      cursor: pointer;
      padding: 8px;
      border-radius: 50%;
      transition: all 0.3s ease;
    }

    .notification-bell:hover {
      background: rgba(59, 130, 246, 0.1);
      transform: scale(1.1);
    }

    .notification-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      background: #ef4444;
      color: white;
      font-size: 10px;
      font-weight: 700;
      min-width: 18px;
      height: 18px;
      border-radius: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      border: 2px solid var(--color-sidebar);
    }

    .notification-badge:empty {
      display: none;
    }

    .nav-section {
      margin-bottom: var(--spacing-lg);
    }

    .nav-section-title {
      padding: 0 var(--spacing-lg);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-sm);
      letter-spacing: 0.5px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      padding: 12px var(--spacing-lg);
      color: var(--color-text-secondary);
      text-decoration: none;
      transition: all 0.2s;
      cursor: pointer;
      border-left: 3px solid transparent;
    }

    .nav-item:hover {
      background: #f3f4f6;
      color: var(--color-text-primary);
    }

    .nav-item.active {
      background: linear-gradient(90deg, rgba(102, 126, 234, 0.1) 0%, transparent 100%);
      color: #667eea;
      border-left-color: #667eea;
      font-weight: 600;
    }

    .nav-icon {
      margin-right: 12px;
      font-size: 18px;
    }

    /* Main Content */
    .main-content {
      margin-left: var(--sidebar-width);
      padding: var(--spacing-lg);
      min-height: 100vh;
    }

    .page {
      display: none;
    }

    .page.active {
      display: block;
    }

    .page-header {
      margin-bottom: var(--spacing-lg);
    }

    .page-title {
      font-size: 28px;
      font-weight: 700;
      color: var(--color-text-primary);
      margin-bottom: var(--spacing-sm);
    }

    .page-subtitle {
      color: var(--color-text-secondary);
    }

    /* Metric Cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: var(--spacing-lg);
      margin-bottom: var(--spacing-lg);
    }

    .metric-card {
      background: var(--color-surface);
      border-radius: var(--border-radius);
      padding: var(--spacing-lg);
      box-shadow: var(--shadow-sm);
      position: relative;
      overflow: hidden;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .metric-card:hover {
      transform: translateY(-4px);
      box-shadow: var(--shadow-lg);
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
    }

    .metric-card.primary::before { background: var(--primary-gradient); }
    .metric-card.success::before { background: var(--success-gradient); }
    .metric-card.warning::before { background: var(--warning-gradient); }
    .metric-card.info::before { background: var(--info-gradient); }

    .metric-icon {
      font-size: 32px;
      margin-bottom: var(--spacing-md);
      opacity: 0.8;
    }

    .metric-card.primary .metric-icon { color: #667eea; }
    .metric-card.success .metric-icon { color: #10b981; }
    .metric-card.warning .metric-icon { color: #f59e0b; }
    .metric-card.info .metric-icon { color: #3b82f6; }

    .metric-value {
      font-size: 36px;
      font-weight: 700;
      margin-bottom: var(--spacing-sm);
    }

    .metric-label {
      color: var(--color-text-secondary);
      font-size: 14px;
    }

    /* Cards */
    .card {
      background: var(--color-surface);
      border-radius: var(--border-radius);
      box-shadow: var(--shadow-sm);
      padding: var(--spacing-lg);
      margin-bottom: var(--spacing-lg);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-md);
    }

    .card-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    /* Search/Filter */
    .search-box {
      width: 100%;
      max-width: 400px;
      padding: 12px 16px;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.2s;
    }

    .search-box:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    /* Table */
    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid var(--color-border);
    }

    th {
      background: #f9fafb;
      font-weight: 600;
      color: var(--color-text-primary);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    tbody tr {
      transition: background 0.2s;
      cursor: pointer;
    }

    tbody tr:hover {
      background: #f9fafb;
    }

    /* Badge */
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .badge.success { background: #d1fae5; color: #065f46; }
    .badge.warning { background: #fef3c7; color: #92400e; }
    .badge.danger { background: #fee2e2; color: #991b1b; }
    .badge.info { background: #dbeafe; color: #1e40af; }

    /* Button */
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-block;
    }

    .btn-primary {
      background: var(--primary-gradient);
      color: white;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .btn-danger {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
    }

    .btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .btn-danger:active {
      transform: translateY(0);
    }

    .btn-success {
      background: var(--success-gradient);
      color: white;
    }

    .btn-success:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .btn-success:active {
      transform: translateY(0);
    }

    .btn-info {
      background: var(--info-gradient);
      color: white;
    }

    .btn-info:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .btn-info:active {
      transform: translateY(0);
    }

    /* Utility Toolbar */
    .utility-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: var(--spacing-lg);
      padding: var(--spacing-md);
      background: var(--color-surface);
      border-radius: var(--border-radius);
      box-shadow: var(--shadow-sm);
    }

    .utility-toolbar .btn {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Toast Notifications */
    .toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 400px;
    }

    .toast {
      background: var(--color-surface);
      border-radius: var(--border-radius);
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      animation: slideInRight 0.3s ease-out;
      border-left: 4px solid;
    }

    @keyframes slideInRight {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes slideOutRight {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }

    .toast.hiding {
      animation: slideOutRight 0.3s ease-in forwards;
    }

    .toast-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .toast-content {
      flex: 1;
    }

    .toast-message {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .toast-success {
      border-left-color: #10b981;
    }

    .toast-success .toast-icon {
      color: #10b981;
    }

    .toast-error {
      border-left-color: #ef4444;
    }

    .toast-error .toast-icon {
      color: #ef4444;
    }

    .toast-info {
      border-left-color: #3b82f6;
    }

    .toast-info .toast-icon {
      color: #3b82f6;
    }

    /* Notification Center */
    .notification-center {
      position: fixed;
      top: 80px;
      left: 280px;
      width: 400px;
      max-height: calc(100vh - 100px);
      background: var(--color-surface);
      border-radius: var(--border-radius);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      z-index: 1000;
      display: none;
      flex-direction: column;
      overflow: hidden;
      animation: slideIn 0.3s ease-out;
    }

    .notification-center.active {
      display: flex;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .notification-center-header {
      padding: var(--spacing-md) var(--spacing-lg);
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .notification-center-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .notification-center-actions {
      display: flex;
      gap: 8px;
    }

    .notification-center-action {
      font-size: 12px;
      color: var(--color-primary);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.2s;
    }

    .notification-center-action:hover {
      background: var(--color-hover);
    }

    .notification-tabs {
      display: flex;
      padding: 0 var(--spacing-lg);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-background);
    }

    .notification-tab {
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text-secondary);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .notification-tab:hover {
      color: var(--color-text-primary);
    }

    .notification-tab.active {
      color: var(--color-primary);
      border-bottom-color: var(--color-primary);
    }

    .notification-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-sm);
    }

    .notification-item {
      display: flex;
      gap: 12px;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: background 0.2s;
      border-left: 3px solid transparent;
    }

    .notification-item:hover {
      background: var(--color-hover);
    }

    .notification-item.unread {
      background: rgba(59, 130, 246, 0.05);
      border-left-color: var(--color-primary);
    }

    .notification-item-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .notification-item-content {
      flex: 1;
      min-width: 0;
    }

    .notification-item-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin-bottom: 4px;
    }

    .notification-item-desc {
      font-size: 13px;
      color: var(--color-text-secondary);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .notification-item-time {
      font-size: 11px;
      color: var(--color-text-tertiary);
    }

    .notification-empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--color-text-secondary);
    }

    .notification-empty-icon {
      font-size: 48px;
      margin-bottom: 12px;
      opacity: 0.3;
    }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--color-text-secondary);
    }

    .empty-icon {
      font-size: 64px;
      margin-bottom: var(--spacing-md);
      opacity: 0.3;
    }

    .empty-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: var(--spacing-sm);
      color: var(--color-text-primary);
    }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal {
      background: var(--color-surface);
      border-radius: var(--border-radius);
      box-shadow: var(--shadow-lg);
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }

    .modal-header {
      padding: var(--spacing-lg);
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-size: 20px;
      font-weight: 600;
    }

    .modal-close {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--color-text-secondary);
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.2s;
    }

    .modal-close:hover {
      background: #f3f4f6;
    }

    .modal-body {
      padding: var(--spacing-lg);
    }

    .patient-info {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-lg);
    }

    .info-item {
      padding: var(--spacing-md);
      background: #f9fafb;
      border-radius: 8px;
    }

    .info-label {
      font-size: 12px;
      color: var(--color-text-secondary);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .info-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .sidebar {
        width: 70px;
      }

      .sidebar-title,
      .nav-section-title,
      .nav-text {
        display: none;
      }

      .main-content {
        margin-left: 70px;
      }

      .metrics-grid {
        grid-template-columns: 1fr;
      }

      .patient-info {
        grid-template-columns: 1fr;
      }

      .utility-toolbar {
        flex-direction: column;
      }

      .utility-toolbar .btn {
        width: 100%;
        justify-content: center;
      }

      .toast-container {
        left: 10px;
        right: 10px;
        max-width: none;
      }

      .toast {
        margin: 0;
      }
    }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title"><img src="/icons/icons-96.png" alt="Sickly Ignite Logo" class="sidebar-logo"> Sickly Ignite</div>
      <div class="notification-bell" onclick="toggleNotificationCenter()">
        🔔
        <span class="notification-badge" id="notification-badge">0</span>
      </div>
    </div>

    <nav>
      <div class="nav-section">
        <div class="nav-section-title">Overview</div>
        <a class="nav-item active" onclick="showPage('dashboard')">
          <span class="nav-icon">📊</span>
          <span class="nav-text">Dashboard</span>
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">Data</div>
        <a class="nav-item" onclick="showPage('patients')">
          <span class="nav-icon">👥</span>
          <span class="nav-text">Patients</span>
        </a>
        <a class="nav-item" onclick="showPage('readings')">
          <span class="nav-icon">📈</span>
          <span class="nav-text">Readings</span>
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">Medications</div>
        <a class="nav-item" onclick="showPage('medications')">
          <span class="nav-icon">💊</span>
          <span class="nav-text">Medications</span>
        </a>
        <a class="nav-item" onclick="showPage('adherence')">
          <span class="nav-icon">✅</span>
          <span class="nav-text">Adherence</span>
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">Emergency</div>
        <a class="nav-item" onclick="showPage('sos')">
          <span class="nav-icon">🚨</span>
          <span class="nav-text">SOS Events</span>
        </a>
      </div>

      <div class="nav-section">
        <div class="nav-section-title">API</div>
        <a class="nav-item" href="/api/patients" target="_blank">
          <span class="nav-icon">📋</span>
          <span class="nav-text">API Endpoints</span>
        </a>
      </div>
    </nav>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <!-- Dashboard Page -->
    <div class="page active" id="dashboard-page">
      <div class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Overview of diabetes monitoring system</p>
      </div>

      <!-- Utility Toolbar -->
      <div class="utility-toolbar">
        <button class="btn btn-primary" onclick="seedData()">
          <span>🌱</span>
          <span>Seed Test Data</span>
        </button>
        <button class="btn btn-danger" onclick="clearData()">
          <span>🗑️</span>
          <span>Clear All Data</span>
        </button>
        <button class="btn btn-info" onclick="refreshDashboard()">
          <span>🔄</span>
          <span>Refresh Dashboard</span>
        </button>
        <button class="btn btn-success" onclick="exportData()">
          <span>📥</span>
          <span>Export Data</span>
        </button>
      </div>

      <div class="metrics-grid">
        <div class="metric-card primary">
          <div class="metric-icon">👥</div>
          <div class="metric-value">${patientsArray.length}</div>
          <div class="metric-label">Total Patients</div>
        </div>

        <div class="metric-card success">
          <div class="metric-icon">📈</div>
          <div class="metric-value">${readings.length}</div>
          <div class="metric-label">Total Readings</div>
        </div>

        <div class="metric-card warning">
          <div class="metric-icon">🕐</div>
          <div class="metric-value">${readings.filter(r => {
            const readingDate = new Date(r.recordedAt);
            const today = new Date();
            return readingDate.toDateString() === today.toDateString();
          }).length}</div>
          <div class="metric-label">Today's Readings</div>
        </div>
      </div>

      <!-- Charts Section -->
      <div class="metrics-grid">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Glucose Readings Trend</h2>
          </div>
          <canvas id="glucoseChart" style="max-height: 300px;"></canvas>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Medication Adherence</h2>
          </div>
          <canvas id="adherenceChart" style="max-height: 300px;"></canvas>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Recent Patients</h2>
          <button class="btn btn-primary" onclick="showPage('patients')">View All</button>
        </div>
        ${patientsArray.length > 0 ? `
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Phone Number</th>
                  <th>Age</th>
                  <th>Diabetes Type</th>
                  <th>Location</th>
                  <th>Registered</th>
                </tr>
              </thead>
              <tbody>
                ${patientsArray.slice(0, 5).map(p => `
                  <tr onclick="showPatientModal('${p.phoneNumber}')">
                    <td>${p.phoneNumber}</td>
                    <td>${p.age} years</td>
                    <td><span class="badge ${p.diabetesType === 'Type 1' ? 'danger' : p.diabetesType === 'Type 2' ? 'warning' : 'info'}">${p.diabetesType}</span></td>
                    <td>${p.county}, ${p.region}</td>
                    <td>${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : 'N/A'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <div class="empty-title">No patients yet</div>
            <p>Patients will appear here once they register via USSD</p>
          </div>
        `}
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Recent Readings</h2>
          <button class="btn btn-primary" onclick="showPage('readings')">View All</button>
        </div>
        ${readings.length > 0 ? `
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Phone Number</th>
                  <th>Glucose</th>
                  <th>Blood Pressure</th>
                  <th>Recorded At</th>
                </tr>
              </thead>
              <tbody>
                ${readings.slice(-5).reverse().map(r => `
                  <tr onclick="showPatientModal('${r.phoneNumber}')">
                    <td>${r.phoneNumber}</td>
                    <td><span class="badge ${r.glucose < 70 ? 'danger' : r.glucose > 180 ? 'warning' : 'success'}">${r.glucose} mg/dL</span></td>
                    <td>${r.bloodPressure}</td>
                    <td>${new Date(r.recordedAt).toLocaleString()}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">📈</div>
            <div class="empty-title">No readings yet</div>
            <p>Health readings will appear here once patients submit them via USSD</p>
          </div>
        `}
      </div>
    </div>

    <!-- Patients Page -->
    <div class="page" id="patients-page">
      <div class="page-header">
        <h1 class="page-title">Patients</h1>
        <p class="page-subtitle">Registered diabetes patients</p>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">All Patients (${patientsArray.length})</h2>
          <input type="text" class="search-box" id="patients-search" placeholder="Search by phone number..." onkeyup="filterPatients()">
        </div>
        ${patientsArray.length > 0 ? `
          <div class="table-container">
            <table id="patients-table">
              <thead>
                <tr>
                  <th>Phone Number</th>
                  <th>Age</th>
                  <th>Diabetes Type</th>
                  <th>Region</th>
                  <th>County</th>
                  <th>Registered</th>
                </tr>
              </thead>
              <tbody>
                ${patientsArray.map(p => `
                  <tr onclick="showPatientModal('${p.phoneNumber}')">
                    <td>${p.phoneNumber}</td>
                    <td>${p.age} years</td>
                    <td><span class="badge ${p.diabetesType === 'Type 1' ? 'danger' : p.diabetesType === 'Type 2' ? 'warning' : 'info'}">${p.diabetesType}</span></td>
                    <td>${p.region}</td>
                    <td>${p.county}</td>
                    <td>${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : 'N/A'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <div class="empty-title">No patients registered</div>
            <p>Patients will appear here once they register via USSD code *384*39981#</p>
          </div>
        `}
      </div>
    </div>

    <!-- Readings Page -->
    <div class="page" id="readings-page">
      <div class="page-header">
        <h1 class="page-title">Health Readings</h1>
        <p class="page-subtitle">Glucose and blood pressure monitoring</p>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">All Readings (${readings.length})</h2>
          <input type="text" class="search-box" id="readings-search" placeholder="Search by phone number..." onkeyup="filterReadings()">
        </div>
        ${readings.length > 0 ? `
          <div class="table-container">
            <table id="readings-table">
              <thead>
                <tr>
                  <th>Phone Number</th>
                  <th>Glucose</th>
                  <th>Blood Pressure</th>
                  <th>Diabetes Type</th>
                  <th>Location</th>
                  <th>Recorded At</th>
                </tr>
              </thead>
              <tbody>
                ${readings.slice().reverse().map(r => `
                  <tr onclick="showPatientModal('${r.phoneNumber}')">
                    <td>${r.phoneNumber}</td>
                    <td><span class="badge ${r.glucose < 70 ? 'danger' : r.glucose > 180 ? 'warning' : 'success'}">${r.glucose} mg/dL</span></td>
                    <td>${r.bloodPressure}</td>
                    <td><span class="badge ${r.diabetesType === 'Type 1' ? 'danger' : r.diabetesType === 'Type 2' ? 'warning' : 'info'}">${r.diabetesType}</span></td>
                    <td>${r.county}, ${r.region}</td>
                    <td>${new Date(r.recordedAt).toLocaleString()}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">📈</div>
            <div class="empty-title">No readings recorded</div>
            <p>Health readings will appear here once patients submit them via USSD</p>
          </div>
        `}
      </div>
    </div>

    <!-- Medications Page -->
    <div class="page" id="medications-page">
      <div class="page-header">
        <h1 class="page-title">Medications</h1>
        <p class="page-subtitle">Active medication schedules for all patients</p>
      </div>

      <div class="metrics-grid">
        <div class="metric-card primary">
          <div class="metric-icon">💊</div>
          <div class="metric-value">${medications.size}</div>
          <div class="metric-label">Total Medications</div>
        </div>

        <div class="metric-card success">
          <div class="metric-icon">✅</div>
          <div class="metric-value">${Array.from(medications.values()).filter(m => m.active).length}</div>
          <div class="metric-label">Active Medications</div>
        </div>

        <div class="metric-card info">
          <div class="metric-icon">👤</div>
          <div class="metric-value">${medications.size}</div>
          <div class="metric-label">Patients with Medications</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">All Medications</h2>
          <div class="search-box">
            <input type="text" id="medication-search" placeholder="Search medications..." onkeyup="filterTable('medication-search', 'medications-table')">
          </div>
        </div>
        ${Array.from(medications.values()).reduce((sum, meds) => sum + meds.length, 0) > 0 ? `
          <div class="table-container">
            <table id="medications-table">
              <thead>
                <tr>
                  <th>Patient Phone</th>
                  <th>Medication</th>
                  <th>Dosage</th>
                  <th>Frequency</th>
                  <th>Times</th>
                  <th>Start Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${Array.from(medications.entries()).flatMap(([phone, meds]) =>
                  meds.map(med => `
                    <tr>
                      <td>${phone}</td>
                      <td><strong>${med.name}</strong></td>
                      <td>${med.dosage}</td>
                      <td><span class="badge info">${med.frequency}</span></td>
                      <td>${med.times.join(', ')}</td>
                      <td>${new Date(med.startDate).toLocaleDateString()}</td>
                      <td><span class="badge ${med.active ? 'success' : 'secondary'}">${med.active ? 'Active' : 'Inactive'}</span></td>
                    </tr>
                  `).join('')
                ).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">💊</div>
            <div class="empty-title">No medications added</div>
            <p>Medications will appear here once patients add them via USSD</p>
          </div>
        `}
      </div>
    </div>

    <!-- Adherence Page -->
    <div class="page" id="adherence-page">
      <div class="page-header">
        <h1 class="page-title">Adherence Tracking</h1>
        <p class="page-subtitle">Monitor medication compliance and adherence rates</p>
      </div>

      <div class="metrics-grid">
        <div class="metric-card success">
          <div class="metric-icon">📊</div>
          <div class="metric-value">${adherenceLog.filter(log => log.status === 'taken').length}</div>
          <div class="metric-label">Doses Taken</div>
        </div>

        <div class="metric-card warning">
          <div class="metric-icon">⚠️</div>
          <div class="metric-value">${adherenceLog.filter(log => log.status === 'missed').length}</div>
          <div class="metric-label">Doses Missed</div>
        </div>

        <div class="metric-card primary">
          <div class="metric-icon">📈</div>
          <div class="metric-value">${adherenceLog.length > 0 ? Math.round((adherenceLog.filter(log => log.status === 'taken').length / adherenceLog.length) * 100) : 0}%</div>
          <div class="metric-label">Overall Adherence Rate</div>
        </div>

        <div class="metric-card info">
          <div class="metric-icon">🕐</div>
          <div class="metric-value">${adherenceLog.filter(log => {
            const logDate = new Date(log.createdAt);
            const today = new Date();
            return logDate.toDateString() === today.toDateString();
          }).length}</div>
          <div class="metric-label">Today's Confirmations</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Adherence Log</h2>
          <div class="search-box">
            <input type="text" id="adherence-search" placeholder="Search adherence records..." onkeyup="filterTable('adherence-search', 'adherence-table')">
          </div>
        </div>
        ${adherenceLog.length > 0 ? `
          <div class="table-container">
            <table id="adherence-table">
              <thead>
                <tr>
                  <th>Patient Phone</th>
                  <th>Medication ID</th>
                  <th>Scheduled Time</th>
                  <th>Taken At</th>
                  <th>Status</th>
                  <th>Method</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                ${adherenceLog.slice().reverse().map(log => `
                  <tr>
                    <td>${log.phoneNumber}</td>
                    <td><code>${log.medicationId}</code></td>
                    <td>${new Date(log.scheduledTime).toLocaleString()}</td>
                    <td>${log.takenAt ? new Date(log.takenAt).toLocaleString() : 'N/A'}</td>
                    <td><span class="badge ${log.status === 'taken' ? 'success' : log.status === 'missed' ? 'danger' : 'warning'}">${log.status}</span></td>
                    <td>${log.method || 'N/A'}</td>
                    <td>${new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <div class="empty-title">No adherence records</div>
            <p>Adherence logs will appear here once patients confirm medication intake</p>
          </div>
        `}
      </div>
    </div>

    <!-- SOS Events Page -->
    <div class="page" id="sos-page">
      <div class="page-header">
        <h1 class="page-title">SOS Events</h1>
        <p class="page-subtitle">Emergency alerts and critical glucose incidents</p>
      </div>

      <div class="metrics-grid">
        <div class="metric-card danger">
          <div class="metric-icon">🚨</div>
          <div class="metric-value">${sosEvents.length}</div>
          <div class="metric-label">Total SOS Events</div>
        </div>

        <div class="metric-card warning">
          <div class="metric-icon">⚠️</div>
          <div class="metric-value">${sosEvents.filter(e => e.status === 'active').length}</div>
          <div class="metric-label">Active Alerts</div>
        </div>

        <div class="metric-card success">
          <div class="metric-icon">✓</div>
          <div class="metric-value">${sosEvents.filter(e => e.status === 'resolved').length}</div>
          <div class="metric-label">Resolved</div>
        </div>

        <div class="metric-card primary">
          <div class="metric-icon">📊</div>
          <div class="metric-value">${sosEvents.filter(e => e.triggerType === 'auto').length}</div>
          <div class="metric-label">Auto-Triggered</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">All SOS Events</h2>
          <div class="search-box">
            <input type="text" id="sos-search" placeholder="Search SOS events..." onkeyup="filterTable('sos-search', 'sos-table')">
          </div>
        </div>
        ${sosEvents.length > 0 ? `
          <div class="table-container">
            <table id="sos-table">
              <thead>
                <tr>
                  <th>Event ID</th>
                  <th>Patient Phone</th>
                  <th>Trigger Type</th>
                  <th>Glucose Reading</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Triggered At</th>
                  <th>Resolved At</th>
                </tr>
              </thead>
              <tbody>
                ${sosEvents.slice().reverse().map(event => `
                  <tr>
                    <td><code>${event.id}</code></td>
                    <td>${event.phoneNumber}</td>
                    <td><span class="badge ${event.triggerType === 'auto' ? 'danger' : 'warning'}">${event.triggerType}</span></td>
                    <td>${event.glucoseReading ? event.glucoseReading + ' mg/dL' : 'N/A'}</td>
                    <td>${event.location || 'N/A'}</td>
                    <td><span class="badge ${event.status === 'active' ? 'danger' : 'success'}">${event.status}</span></td>
                    <td>${new Date(event.createdAt).toLocaleString()}</td>
                    <td>${event.resolvedAt ? new Date(event.resolvedAt).toLocaleString() : 'N/A'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-icon">🚨</div>
            <div class="empty-title">No SOS events</div>
            <p>Emergency alerts will appear here when patients trigger SOS or critical glucose levels are detected</p>
          </div>
        `}
      </div>
    </div>
  </div>

  <!-- Patient Details Modal -->
  <div class="modal-overlay" id="patient-modal">
    <div class="modal">
      <div class="modal-header">
        <h3 class="modal-title">Patient Details</h3>
        <button class="modal-close" onclick="closePatientModal()">×</button>
      </div>
      <div class="modal-body" id="modal-content">
        <!-- Content will be populated by JavaScript -->
      </div>
    </div>
  </div>

  <!-- Toast Container -->
  <div class="toast-container" id="toast-container"></div>

  <!-- Notification Center -->
  <div class="notification-center" id="notification-center">
    <div class="notification-center-header">
      <div class="notification-center-title">Notifications</div>
      <div class="notification-center-actions">
        <div class="notification-center-action" onclick="markAllAsRead()">Mark all read</div>
        <div class="notification-center-action" onclick="clearAllNotifications()">Clear all</div>
      </div>
    </div>

    <div class="notification-tabs">
      <div class="notification-tab active" onclick="filterNotifications('all')">All</div>
      <div class="notification-tab" onclick="filterNotifications('sos')">SOS</div>
      <div class="notification-tab" onclick="filterNotifications('critical')">Critical</div>
      <div class="notification-tab" onclick="filterNotifications('medication')">Medication</div>
    </div>

    <div class="notification-list" id="notification-list">
      <div class="notification-empty">
        <div class="notification-empty-icon">🔔</div>
        <div>No notifications</div>
      </div>
    </div>
  </div>

  <script>
    // Patient and reading data
    const patientsData = ${JSON.stringify(patientsArray)};
    const readingsData = ${JSON.stringify(readings)};

    // Navigation
    function showPage(pageName) {
      // Hide all pages
      document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
      });

      // Remove active from all nav items
      document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
      });

      // Show selected page
      document.getElementById(pageName + '-page').classList.add('active');

      // Set active nav item
      event.target.closest('.nav-item').classList.add('active');
    }

    // Filter patients
    function filterPatients() {
      const searchTerm = document.getElementById('patients-search').value.toLowerCase();
      const rows = document.querySelectorAll('#patients-table tbody tr');

      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(searchTerm) ? '' : 'none';
      });
    }

    // Filter readings
    function filterReadings() {
      const searchTerm = document.getElementById('readings-search').value.toLowerCase();
      const rows = document.querySelectorAll('#readings-table tbody tr');

      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(searchTerm) ? '' : 'none';
      });
    }

    // Generic filter function for any table
    function filterTable(searchId, tableId) {
      const searchTerm = document.getElementById(searchId).value.toLowerCase();
      const rows = document.querySelectorAll('#' + tableId + ' tbody tr');

      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(searchTerm) ? '' : 'none';
      });
    }

    // Show patient modal
    function showPatientModal(phoneNumber) {
      const patient = patientsData.find(p => p.phoneNumber === phoneNumber);
      const patientReadings = readingsData.filter(r => r.phoneNumber === phoneNumber);
      const patientContacts = emergencyContacts.get(phoneNumber) || [];

      if (!patient) return;

      const modalContent = document.getElementById('modal-content');
      modalContent.innerHTML = \`
        <div class="patient-info">
          <div class="info-item">
            <div class="info-label">Phone Number</div>
            <div class="info-value">\${patient.phoneNumber}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Age</div>
            <div class="info-value">\${patient.age} years</div>
          </div>
          <div class="info-item">
            <div class="info-label">Diabetes Type</div>
            <div class="info-value">\${patient.diabetesType}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Region</div>
            <div class="info-value">\${patient.region}</div>
          </div>
          <div class="info-item">
            <div class="info-label">County</div>
            <div class="info-value">\${patient.county}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Registered</div>
            <div class="info-value">\${patient.savedAt ? new Date(patient.savedAt).toLocaleDateString() : 'N/A'}</div>
          </div>
        </div>

        <h4 style="margin-bottom: 16px; margin-top: 24px; font-size: 16px; font-weight: 600;">Emergency Contacts (\${patientContacts.length})</h4>

        \${patientContacts.length > 0 ? \`
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Relationship</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody>
                \${patientContacts.sort((a, b) => a.priority - b.priority).map(c => \`
                  <tr>
                    <td>\${c.contactName}</td>
                    <td>\${c.contactPhone}</td>
                    <td>\${c.relationship}</td>
                    <td><span class="badge \${c.priority === 1 ? 'danger' : 'info'}">Priority \${c.priority}</span></td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        \` : \`
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <div class="empty-title">No emergency contacts</div>
            <p>This patient hasn't added any emergency contacts yet</p>
          </div>
        \`}

        <h4 style="margin-bottom: 16px; margin-top: 24px; font-size: 16px; font-weight: 600;">Health Readings History (\${patientReadings.length})</h4>

        \${patientReadings.length > 0 ? \`
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Glucose</th>
                  <th>Blood Pressure</th>
                  <th>Recorded At</th>
                </tr>
              </thead>
              <tbody>
                \${patientReadings.slice().reverse().map(r => \`
                  <tr>
                    <td><span class="badge \${r.glucose < 70 ? 'danger' : r.glucose > 180 ? 'warning' : 'success'}">\${r.glucose} mg/dL</span></td>
                    <td>\${r.bloodPressure}</td>
                    <td>\${new Date(r.recordedAt).toLocaleString()}</td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        \` : \`
          <div class="empty-state">
            <div class="empty-icon">📈</div>
            <div class="empty-title">No readings yet</div>
            <p>This patient hasn't submitted any health readings</p>
          </div>
        \`}
      \`;

      document.getElementById('patient-modal').classList.add('active');
    }

    // Close patient modal
    function closePatientModal() {
      document.getElementById('patient-modal').classList.remove('active');
    }

    // Close modal when clicking outside
    document.getElementById('patient-modal').addEventListener('click', function(e) {
      if (e.target === this) {
        closePatientModal();
      }
    });

    // Chart initialization
    async function initCharts() {
      try {
        // Fetch readings data
        const readingsResponse = await fetch('/api/readings');
        const readingsData = await readingsResponse.json();

        // Fetch adherence stats (we'll use overall stats for demo)
        const adherenceResponse = await fetch('/api/stats');
        const statsData = await adherenceResponse.json();

        // Initialize Glucose Chart
        const glucoseCtx = document.getElementById('glucoseChart').getContext('2d');

        // Prepare glucose data - get last 10 readings
        const recentReadings = readingsData.readings.slice(-10);
        const glucoseLabels = recentReadings.map(r => {
          const date = new Date(r.recordedAt);
          return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        const glucoseValues = recentReadings.map(r => r.glucose);

        new Chart(glucoseCtx, {
          type: 'line',
          data: {
            labels: glucoseLabels,
            datasets: [{
              label: 'Glucose Level (mg/dL)',
              data: glucoseValues,
              borderColor: '#667eea',
              backgroundColor: 'rgba(102, 126, 234, 0.1)',
              borderWidth: 3,
              fill: true,
              tension: 0.4,
              pointBackgroundColor: '#667eea',
              pointBorderColor: '#fff',
              pointBorderWidth: 2,
              pointRadius: 5,
              pointHoverRadius: 7
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: {
                display: true,
                position: 'top',
                labels: {
                  font: { size: 12, weight: '600' },
                  color: '#1f2937',
                  padding: 15
                }
              },
              tooltip: {
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                padding: 12,
                titleFont: { size: 13 },
                bodyFont: { size: 12 },
                cornerRadius: 8
              }
            },
            scales: {
              y: {
                beginAtZero: false,
                grid: {
                  color: 'rgba(0, 0, 0, 0.05)'
                },
                ticks: {
                  color: '#6b7280',
                  font: { size: 11 }
                }
              },
              x: {
                grid: {
                  display: false
                },
                ticks: {
                  color: '#6b7280',
                  font: { size: 11 }
                }
              }
            }
          }
        });

        // Initialize Adherence Chart
        const adherenceCtx = document.getElementById('adherenceChart').getContext('2d');

        new Chart(adherenceCtx, {
          type: 'doughnut',
          data: {
            labels: ['Taken', 'Missed'],
            datasets: [{
              data: [statsData.totalAdherence || 0, statsData.totalMissed || 0],
              backgroundColor: [
                '#10b981',
                '#f59e0b'
              ],
              borderWidth: 0,
              hoverOffset: 10
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: {
                display: true,
                position: 'bottom',
                labels: {
                  font: { size: 12, weight: '600' },
                  color: '#1f2937',
                  padding: 15,
                  usePointStyle: true,
                  pointStyle: 'circle'
                }
              },
              tooltip: {
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                padding: 12,
                titleFont: { size: 13 },
                bodyFont: { size: 12 },
                cornerRadius: 8,
                callbacks: {
                  label: function(context) {
                    const label = context.label || '';
                    const value = context.parsed || 0;
                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                    const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                    return label + ': ' + value + ' (' + percentage + '%)';
                  }
                }
              }
            },
            cutout: '65%'
          }
        });

      } catch (error) {
        console.error('Error initializing charts:', error);
      }
    }

    // Initialize charts when page loads
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCharts);
    } else {
      initCharts();
    }

    // ===== TOAST NOTIFICATION SYSTEM =====
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');

      // Set toast classes
      toast.className = \`toast toast-\${type}\`;

      // Determine icon based on type
      let icon = '';
      switch(type) {
        case 'success':
          icon = '✓';
          break;
        case 'error':
          icon = '✗';
          break;
        case 'info':
        default:
          icon = 'ℹ';
          break;
      }

      // Create toast HTML
      toast.innerHTML = \`
        <div class="toast-icon">\${icon}</div>
        <div class="toast-content">
          <div class="toast-message">\${message}</div>
        </div>
      \`;

      // Add to container
      container.appendChild(toast);

      // Auto-dismiss after 3 seconds
      setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => {
          if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
          }
        }, 300); // Wait for animation to complete
      }, 3000);
    }

    // ===== NOTIFICATION CENTER SYSTEM =====
    let notifications = [];
    let currentFilter = 'all';

    // Load notifications from localStorage
    function loadNotifications() {
      const stored = localStorage.getItem('sickly-notifications');
      if (stored) {
        notifications = JSON.parse(stored);
      }
    }

    // Save notifications to localStorage
    function saveNotifications() {
      localStorage.setItem('sickly-notifications', JSON.stringify(notifications));
    }

    // Toggle notification center
    function toggleNotificationCenter() {
      const center = document.getElementById('notification-center');
      center.classList.toggle('active');

      if (center.classList.contains('active')) {
        renderNotifications();
      }
    }

    // Close notification center when clicking outside
    document.addEventListener('click', function(e) {
      const center = document.getElementById('notification-center');
      const bell = document.querySelector('.notification-bell');

      if (center.classList.contains('active') && !center.contains(e.target) && !bell.contains(e.target)) {
        center.classList.remove('active');
      }
    });

    // Add notification
    function addNotification(type, title, description, data = {}) {
      const notification = {
        id: Date.now() + Math.random(),
        type,
        title,
        description,
        timestamp: new Date().toISOString(),
        read: false,
        data
      };

      notifications.unshift(notification);
      saveNotifications();
      updateBadge();

      if (document.getElementById('notification-center').classList.contains('active')) {
        renderNotifications();
      }
    }

    // Update badge counter
    function updateBadge() {
      const badge = document.getElementById('notification-badge');
      const unreadCount = notifications.filter(n => !n.read).length;
      badge.textContent = unreadCount;
      badge.style.display = unreadCount > 0 ? 'flex' : 'none';
    }

    // Mark all as read
    function markAllAsRead() {
      notifications.forEach(n => n.read = true);
      saveNotifications();
      updateBadge();
      renderNotifications();
    }

    // Clear all notifications
    function clearAllNotifications() {
      if (confirm('Are you sure you want to clear all notifications?')) {
        notifications = [];
        saveNotifications();
        updateBadge();
        renderNotifications();
      }
    }

    // Filter notifications
    function filterNotifications(filter) {
      currentFilter = filter;

      // Update tab active state
      document.querySelectorAll('.notification-tab').forEach(tab => {
        tab.classList.remove('active');
      });
      event.target.classList.add('active');

      renderNotifications();
    }

    // Get icon by type
    function getNotificationIcon(type) {
      const icons = {
        sos: '🚨',
        critical: '⚠️',
        medication: '💊',
        patient: '👤',
        system: '✓'
      };
      return icons[type] || 'ℹ';
    }

    // Format time ago
    function timeAgo(timestamp) {
      const now = new Date();
      const then = new Date(timestamp);
      const seconds = Math.floor((now - then) / 1000);

      if (seconds < 60) return 'Just now';
      if (seconds < 3600) return \`\${Math.floor(seconds / 60)}m ago\`;
      if (seconds < 86400) return \`\${Math.floor(seconds / 3600)}h ago\`;
      if (seconds < 604800) return \`\${Math.floor(seconds / 86400)}d ago\`;
      return then.toLocaleDateString();
    }

    // Render notifications
    function renderNotifications() {
      const list = document.getElementById('notification-list');

      let filtered = notifications;
      if (currentFilter !== 'all') {
        filtered = notifications.filter(n => n.type === currentFilter);
      }

      if (filtered.length === 0) {
        list.innerHTML = \`
          <div class="notification-empty">
            <div class="notification-empty-icon">🔔</div>
            <div>No \${currentFilter === 'all' ? '' : currentFilter} notifications</div>
          </div>
        \`;
        return;
      }

      list.innerHTML = filtered.map(n => \`
        <div class="notification-item \${!n.read ? 'unread' : ''}" onclick="handleNotificationClick('\${n.id}', '\${n.type}', '\${n.data.page || ''}')">
          <div class="notification-item-icon">\${getNotificationIcon(n.type)}</div>
          <div class="notification-item-content">
            <div class="notification-item-title">\${n.title}</div>
            <div class="notification-item-desc">\${n.description}</div>
            <div class="notification-item-time">\${timeAgo(n.timestamp)}</div>
          </div>
        </div>
      \`).join('');
    }

    // Handle notification click
    function handleNotificationClick(id, type, page) {
      // Mark as read
      const notification = notifications.find(n => n.id == id);
      if (notification) {
        notification.read = true;
        saveNotifications();
        updateBadge();
        renderNotifications();
      }

      // Navigate to relevant page
      if (page && page !== '') {
        toggleNotificationCenter();
        showPage(page);
      }
    }

    // Generate notifications from data
    function generateNotifications() {
      const sosData = ${JSON.stringify(sosEvents)};
      const readingData = ${JSON.stringify(readings)};

      // SOS notifications (active events)
      sosData.filter(s => s.status === 'active').forEach(sos => {
        addNotification(
          'sos',
          'SOS Alert',
          \`Emergency alert from \${sos.phoneNumber} - Glucose: \${sos.glucoseReading} mg/dL\`,
          { page: 'sos', sosId: sos.id }
        );
      });

      // Critical glucose readings (last 24 hours)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      readingData
        .filter(r => new Date(r.recordedAt) > yesterday && (r.glucose < 70 || r.glucose > 180))
        .slice(0, 5)
        .forEach(reading => {
          const level = reading.glucose < 70 ? 'Low' : 'High';
          addNotification(
            'critical',
            \`\${level} Glucose Alert\`,
            \`Patient \${reading.phoneNumber}: \${reading.glucose} mg/dL\`,
            { page: 'readings' }
          );
        });

      // New patients (today)
      const today = new Date().toDateString();
      patientsData
        .filter(p => p.savedAt && new Date(p.savedAt).toDateString() === today)
        .forEach(patient => {
          addNotification(
            'patient',
            'New Patient Registered',
            \`\${patient.phoneNumber} - \${patient.diabetesType}\`,
            { page: 'patients' }
          );
        });
    }

    // Initialize notifications
    loadNotifications();
    updateBadge();

    // Generate fresh notifications on page load
    if (notifications.length === 0) {
      generateNotifications();
    }

    // ===== UTILITY FUNCTIONS =====

    // Seed test data
    async function seedData() {
      try {
        showToast('Seeding test data...', 'info');

        const response = await fetch('/api/seed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const result = await response.json();

        if (result.success) {
          showToast(\`Successfully seeded \${result.summary.patients} patients, \${result.summary.readings} readings, and more!\`, 'success');

          // Refresh page after 2 seconds
          setTimeout(() => {
            window.location.reload();
          }, 2000);
        } else {
          showToast('Failed to seed data: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        console.error('Error seeding data:', error);
        showToast('Error seeding data: ' + error.message, 'error');
      }
    }

    // Clear all data
    async function clearData() {
      // Confirm with user
      const confirmed = confirm('Are you sure you want to clear ALL data? This action cannot be undone.');

      if (!confirmed) {
        return;
      }

      try {
        showToast('Clearing all data...', 'info');

        const response = await fetch('/api/reset', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const result = await response.json();

        if (result.success) {
          showToast('All data has been cleared successfully!', 'success');

          // Refresh page after 2 seconds
          setTimeout(() => {
            window.location.reload();
          }, 2000);
        } else {
          showToast('Failed to clear data: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (error) {
        console.error('Error clearing data:', error);
        showToast('Error clearing data: ' + error.message, 'error');
      }
    }

    // Refresh dashboard
    function refreshDashboard() {
      showToast('Refreshing dashboard...', 'info');
      setTimeout(() => {
        window.location.reload();
      }, 500);
    }

    // Export all data as JSON
    async function exportData() {
      try {
        showToast('Exporting data...', 'info');

        // Fetch all data from API endpoints
        const [patientsRes, readingsRes, medicationsRes, adherenceRes, sosRes, statsRes] = await Promise.all([
          fetch('/api/patients'),
          fetch('/api/readings'),
          fetch('/api/medications'),
          fetch('/api/adherence'),
          fetch('/api/sos/events'),
          fetch('/api/stats')
        ]);

        const exportData = {
          metadata: {
            exportedAt: new Date().toISOString(),
            exportedBy: 'Sickly Ignite Dashboard',
            version: '1.0'
          },
          patients: await patientsRes.json(),
          readings: await readingsRes.json(),
          medications: await medicationsRes.json(),
          adherence: await adherenceRes.json(),
          sosEvents: await sosRes.json(),
          stats: await statsRes.json()
        };

        // Create downloadable JSON file
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);

        // Create download link
        const link = document.createElement('a');
        link.href = url;
        link.download = \`sickly-ignite-export-\${new Date().toISOString().split('T')[0]}.json\`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Clean up
        URL.revokeObjectURL(url);

        showToast('Data exported successfully!', 'success');
      } catch (error) {
        console.error('Error exporting data:', error);
        showToast('Error exporting data: ' + error.message, 'error');
      }
    }
  </script>
</body>
</html>
  `;

  res.send(html);
});

// API Endpoints for JSON data
app.get('/api/patients', (req, res) => {
  const patientsArray = Array.from(patients.values());
  res.json({
    total: patientsArray.length,
    patients: patientsArray
  });
});

app.get('/api/readings', (req, res) => {
  res.json({
    total: readings.length,
    readings: readings
  });
});

app.get('/api/stats', (req, res) => {
  const totalMedications = medications.size;
  const totalActiveMedications = Array.from(medications.values())
    .filter(m => m.active).length;
  const totalAdherence = adherenceLog.filter(a => a.status === 'taken').length;
  const totalMissed = adherenceLog.filter(a => a.status === 'missed').length;
  const adherenceRate = adherenceLog.length > 0
    ? ((totalAdherence / adherenceLog.length) * 100).toFixed(1)
    : 0;
  const activeSos = sosEvents.filter(e => e.status === 'active').length;

  res.json({
    totalPatients: patients.size,
    totalReadings: readings.length,
    totalMedications,
    totalActiveMedications,
    adherenceRate: parseFloat(adherenceRate),
    totalAdherence,
    totalMissed,
    activeSosEvents: activeSos,
    timestamp: new Date().toISOString()
  });
});

// ===== MEDICATION API ENDPOINTS =====

// Get all medications
app.get('/api/medications', (req, res) => {
  const allMedications = [];
  medications.forEach((meds, phoneNumber) => {
    meds.forEach(med => {
      allMedications.push({ ...med, phoneNumber });
    });
  });
  res.json({
    total: allMedications.length,
    medications: allMedications
  });
});

// Get medications for a specific patient
app.get('/api/medications/:phone', (req, res) => {
  const { phone } = req.params;
  const patientMeds = medications.get(phone) || [];
  res.json({
    phoneNumber: phone,
    total: patientMeds.length,
    medications: patientMeds
  });
});

// Add new medication
app.post('/api/medications', (req, res) => {
  const { phoneNumber, name, dosage, frequency, times, startDate } = req.body;

  if (!phoneNumber || !name || !dosage || !frequency) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const medication = {
    id: generateMedicationId(),
    name,
    dosage,
    frequency,
    times: times || [],
    startDate: startDate || new Date().toISOString(),
    active: true,
    createdAt: new Date().toISOString()
  };

  const patientMeds = medications.get(phoneNumber) || [];
  patientMeds.push(medication);
  medications.set(phoneNumber, patientMeds);
  scheduleSave(); // Save to file

  res.status(201).json({
    success: true,
    medication
  });
});

// Update medication
app.put('/api/medications/:id', (req, res) => {
  const { id } = req.params;
  const { phoneNumber, active } = req.body;

  const patientMeds = medications.get(phoneNumber);
  if (!patientMeds) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const med = patientMeds.find(m => m.id === id);
  if (!med) {
    return res.status(404).json({ error: 'Medication not found' });
  }

  // Update fields
  if (active !== undefined) med.active = active;
  scheduleSave(); // Save to file

  res.json({
    success: true,
    medication: med
  });
});

// Delete (deactivate) medication
app.delete('/api/medications/:id', (req, res) => {
  const { id } = req.params;
  const { phoneNumber } = req.query;

  const patientMeds = medications.get(phoneNumber);
  if (!patientMeds) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const med = patientMeds.find(m => m.id === id);
  if (!med) {
    return res.status(404).json({ error: 'Medication not found' });
  }

  med.active = false;
  scheduleSave(); // Save to file

  res.json({
    success: true,
    message: 'Medication deactivated'
  });
});

// ===== ADHERENCE API ENDPOINTS =====

// Get all adherence records
app.get('/api/adherence', (req, res) => {
  res.json({
    total: adherenceLog.length,
    adherence: adherenceLog
  });
});

// Get adherence for specific patient
app.get('/api/adherence/:phone', (req, res) => {
  const { phone } = req.params;
  const patientAdherence = adherenceLog.filter(a => a.phoneNumber === phone);
  res.json({
    phoneNumber: phone,
    total: patientAdherence.length,
    adherence: patientAdherence
  });
});

// Get adherence statistics
app.get('/api/adherence/stats/:phone', (req, res) => {
  const { phone } = req.params;
  const patientAdherence = adherenceLog.filter(a => a.phoneNumber === phone);

  const taken = patientAdherence.filter(a => a.status === 'taken').length;
  const missed = patientAdherence.filter(a => a.status === 'missed').length;
  const pending = patientAdherence.filter(a => a.status === 'pending').length;
  const rate = patientAdherence.length > 0
    ? ((taken / patientAdherence.length) * 100).toFixed(1)
    : 0;

  res.json({
    phoneNumber: phone,
    total: patientAdherence.length,
    taken,
    missed,
    pending,
    adherenceRate: parseFloat(rate)
  });
});

// Confirm medication taken
app.post('/api/adherence/confirm', (req, res) => {
  const { phoneNumber, medicationId, method } = req.body;

  if (!phoneNumber || !medicationId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Find or create adherence record
  const now = new Date();
  const adherenceRecord = {
    phoneNumber,
    medicationId,
    scheduledTime: now.toISOString(),
    takenAt: now.toISOString(),
    status: 'taken',
    method: method || 'ussd-confirm',
    createdAt: now.toISOString()
  };

  adherenceLog.push(adherenceRecord);
  scheduleSave(); // Save to file

  res.json({
    success: true,
    adherence: adherenceRecord
  });
});

// ===== EMERGENCY CONTACTS API ENDPOINTS =====

// Get emergency contacts for a patient
app.get('/api/emergency-contacts/:phone', (req, res) => {
  const { phone } = req.params;
  const contacts = emergencyContacts.get(phone) || [];
  res.json({
    phoneNumber: phone,
    total: contacts.length,
    contacts
  });
});

// Add emergency contact
app.post('/api/emergency-contacts', (req, res) => {
  const { phoneNumber, contactName, contactPhone, relationship, priority } = req.body;

  if (!phoneNumber || !contactName || !contactPhone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const contact = {
    contactName,
    contactPhone,
    relationship: relationship || 'family',
    priority: priority || 1,
    createdAt: new Date().toISOString()
  };

  const patientContacts = emergencyContacts.get(phoneNumber) || [];
  patientContacts.push(contact);
  emergencyContacts.set(phoneNumber, patientContacts);
  scheduleSave(); // Save to file

  res.json({
    success: true,
    contact
  });
});

// Delete emergency contact
app.delete('/api/emergency-contacts', (req, res) => {
  const { phoneNumber, contactPhone } = req.query;

  const contacts = emergencyContacts.get(phoneNumber);
  if (!contacts) {
    return res.status(404).json({ error: 'No contacts found' });
  }

  const filtered = contacts.filter(c => c.contactPhone !== contactPhone);
  emergencyContacts.set(phoneNumber, filtered);
  scheduleSave(); // Save to file

  res.json({
    success: true,
    message: 'Contact removed'
  });
});

// ===== SOS API ENDPOINTS =====

// Get all SOS events
app.get('/api/sos/events', (req, res) => {
  res.json({
    total: sosEvents.length,
    events: sosEvents
  });
});

// Get SOS events for a patient
app.get('/api/sos/events/:phone', (req, res) => {
  const { phone } = req.params;
  const patientSos = sosEvents.filter(e => e.phoneNumber === phone);
  res.json({
    phoneNumber: phone,
    total: patientSos.length,
    events: patientSos
  });
});

// Trigger SOS
app.post('/api/sos/trigger', (req, res) => {
  const { phoneNumber, triggerType, glucoseReading, location } = req.body;

  if (!phoneNumber || !triggerType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const patient = patients.get(phoneNumber);
  const contacts = emergencyContacts.get(phoneNumber) || [];

  const sosEvent = {
    id: generateSosEventId(),
    phoneNumber,
    triggerType,
    glucoseReading: glucoseReading || null,
    location: location || (patient ? `${patient.county}, ${patient.region}` : 'Unknown'),
    timestamp: new Date().toISOString(),
    notifiedContacts: contacts.map(c => c.contactPhone),
    status: 'active'
  };

  sosEvents.push(sosEvent);
  scheduleSave(); // Save to file

  // Send SMS alerts to emergency contacts asynchronously
  sendSOSAlerts(phoneNumber, sosEvent)
    .then(alertResult => {
      console.log('SOS SMS alerts sent:', alertResult);
    })
    .catch(error => {
      console.error('Failed to send SOS alerts:', error.message);
    });

  res.json({
    success: true,
    sosEvent,
    message: 'SOS alert triggered successfully',
    alertsInitiated: contacts.length
  });
});

// Resolve SOS event
app.put('/api/sos/:id/resolve', (req, res) => {
  const { id } = req.params;

  const sosEvent = sosEvents.find(e => e.id === id);
  if (!sosEvent) {
    return res.status(404).json({ error: 'SOS event not found' });
  }

  sosEvent.status = 'resolved';
  sosEvent.resolvedAt = new Date().toISOString();
  scheduleSave(); // Save to file

  res.json({
    success: true,
    sosEvent
  });
});

// ===== DATA MANAGEMENT API ENDPOINTS =====

// Seed test data
app.post('/api/seed', async (req, res) => {
  try {
    console.log('Seeding test data...');

    // Sample patients
    const samplePatients = [
      {
        phoneNumber: '+254712345678',
        age: 45,
        diabetesType: 'Type 2',
        region: 'Nairobi',
        county: 'Nairobi',
        savedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
      },
      {
        phoneNumber: '+254723456789',
        age: 32,
        diabetesType: 'Type 1',
        region: 'Central',
        county: 'Kiambu',
        savedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60 days ago
      },
      {
        phoneNumber: '+254734567890',
        age: 58,
        diabetesType: 'Type 2',
        region: 'Coast',
        county: 'Mombasa',
        savedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() // 15 days ago
      }
    ];

    // Add patients
    samplePatients.forEach(patient => {
      patients.set(patient.phoneNumber, patient);
    });

    // Sample readings for each patient
    const sampleReadings = [];
    samplePatients.forEach(patient => {
      // Generate 10 readings over the past 10 days
      for (let i = 0; i < 10; i++) {
        const daysAgo = 10 - i;
        const recordedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

        // Vary glucose readings (70-250 mg/dL)
        const glucose = Math.floor(80 + Math.random() * 170);

        // Random blood pressure
        const systolic = Math.floor(110 + Math.random() * 40);
        const diastolic = Math.floor(70 + Math.random() * 20);

        sampleReadings.push({
          phoneNumber: patient.phoneNumber,
          age: patient.age,
          diabetesType: patient.diabetesType,
          region: patient.region,
          county: patient.county,
          glucose,
          bloodPressure: `${systolic}/${diastolic}`,
          recordedAt
        });
      }
    });

    readings.push(...sampleReadings);

    // Sample medications - grouped by phoneNumber
    const medicationsData = [
      {
        phoneNumber: '+254712345678',
        meds: [
          {
            id: `MED${++medicationIdCounter}`,
            name: 'Metformin',
            dosage: '500mg',
            frequency: 'twice',
            times: ['08:00', '20:00'],
            startDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
            active: true,
            createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        phoneNumber: '+254723456789',
        meds: [
          {
            id: `MED${++medicationIdCounter}`,
            name: 'Insulin Glargine',
            dosage: '10 units',
            frequency: 'once',
            times: ['22:00'],
            startDate: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
            active: true,
            createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        phoneNumber: '+254734567890',
        meds: [
          {
            id: `MED${++medicationIdCounter}`,
            name: 'Gliclazide',
            dosage: '80mg',
            frequency: 'once',
            times: ['07:00'],
            startDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
            active: true,
            createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
      }
    ];

    // Store medications by phoneNumber with array of meds
    medicationsData.forEach(({ phoneNumber, meds }) => {
      medications.set(phoneNumber, meds);
    });

    // Sample adherence logs
    const sampleAdherence = [];
    medicationsData.forEach(({ phoneNumber, meds }) => {
      meds.forEach(med => {
        // Generate adherence records for past 7 days
        for (let day = 0; day < 7; day++) {
          med.times.forEach(time => {
            const daysAgo = 7 - day;
            const scheduledDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
            const [hours, minutes] = time.split(':');
            scheduledDate.setHours(parseInt(hours), parseInt(minutes), 0);

            const status = Math.random() > 0.3 ? 'taken' : 'missed'; // 70% adherence

            sampleAdherence.push({
              phoneNumber,
              medicationId: med.id,
              scheduledTime: scheduledDate.toISOString(),
              takenAt: status === 'taken' ? scheduledDate.toISOString() : null,
              status,
              method: status === 'taken' ? (Math.random() > 0.5 ? 'sms' : 'ussd-confirm') : null,
              createdAt: scheduledDate.toISOString()
            });
          });
        }
      });
    });

    adherenceLog.push(...sampleAdherence);

    // Sample emergency contacts
    const sampleContacts = [
      {
        phoneNumber: '+254712345678',
        contacts: [
          {
            contactName: 'Jane Doe',
            contactPhone: '+254798765432',
            relationship: 'Spouse',
            priority: 1,
            createdAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString()
          },
          {
            contactName: 'Dr. Smith',
            contactPhone: '+254787654321',
            relationship: 'Doctor',
            priority: 2,
            createdAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
      },
      {
        phoneNumber: '+254723456789',
        contacts: [
          {
            contactName: 'John Kamau',
            contactPhone: '+254776543210',
            relationship: 'Brother',
            priority: 1,
            createdAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
      }
    ];

    sampleContacts.forEach(({ phoneNumber, contacts }) => {
      emergencyContacts.set(phoneNumber, contacts);
    });

    // Sample SOS events
    const sampleSOS = [
      {
        id: `SOS${++sosEventIdCounter}`,
        phoneNumber: '+254712345678',
        triggerType: 'auto',
        glucoseReading: 55,
        location: 'Nairobi, Nairobi',
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        notifiedContacts: ['+254798765432', '+254787654321'],
        status: 'resolved',
        resolvedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString()
      },
      {
        id: `SOS${++sosEventIdCounter}`,
        phoneNumber: '+254723456789',
        triggerType: 'manual',
        glucoseReading: null,
        location: 'Kiambu, Central',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        notifiedContacts: ['+254776543210'],
        status: 'active'
      }
    ];

    sosEvents.push(...sampleSOS);

    // Save all data to files
    await saveData();

    console.log('Test data seeded successfully!');
    console.log(`- ${samplePatients.length} patients`);
    console.log(`- ${sampleReadings.length} readings`);
    console.log(`- ${sampleMedications.length} medications`);
    console.log(`- ${sampleAdherence.length} adherence logs`);
    console.log(`- ${sampleContacts.length} emergency contact groups`);
    console.log(`- ${sampleSOS.length} SOS events`);

    res.json({
      success: true,
      message: 'Test data seeded successfully',
      summary: {
        patients: samplePatients.length,
        readings: sampleReadings.length,
        medications: sampleMedications.length,
        adherenceLogs: sampleAdherence.length,
        emergencyContactGroups: sampleContacts.length,
        sosEvents: sampleSOS.length
      }
    });
  } catch (error) {
    console.error('Error seeding data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to seed test data',
      details: error.message
    });
  }
});

// Reset/clear all data
app.post('/api/reset', async (req, res) => {
  try {
    console.log('========================================');
    console.log('CLEARING ALL DATA FROM SYSTEM');
    console.log('========================================');
    console.log(`Before clear - Patients: ${patients.size}, Readings: ${readings.length}, Medications: ${medications.size}`);
    console.log(`Before clear - Adherence Logs: ${adherenceLog.length}, Emergency Contacts: ${emergencyContacts.size}, SOS Events: ${sosEvents.length}`);

    // Clear all in-memory data structures
    patients.clear();
    readings.length = 0;
    medications.clear();
    adherenceLog.length = 0;
    emergencyContacts.clear();
    sosEvents.length = 0;

    console.log('In-memory data cleared');

    // Reset ID counters to start from 1
    medicationIdCounter = 1;
    sosEventIdCounter = 1;

    console.log('Counters reset to 1');

    // Save empty data to all JSON files (will overwrite existing files)
    await saveData();

    console.log('Empty state saved to all JSON files');
    console.log(`After clear - Patients: ${patients.size}, Readings: ${readings.length}, Medications: ${medications.size}`);
    console.log(`After clear - Adherence Logs: ${adherenceLog.length}, Emergency Contacts: ${emergencyContacts.size}, SOS Events: ${sosEvents.length}`);
    console.log('========================================');
    console.log('ALL DATA CLEARED SUCCESSFULLY!');
    console.log('========================================');

    res.json({
      success: true,
      message: 'All data has been cleared (seed data and manually added data)',
      cleared: {
        patients: true,
        readings: true,
        medications: true,
        adherenceLogs: true,
        emergencyContacts: true,
        sosEvents: true,
        counters: true
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error clearing data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear data',
      details: error.message
    });
  }
});

// ===== SERVE ICON FILES =====
app.get('/icons/:filename', (req, res) => {
  res.sendFile(path.join(__dirname, 'icons', req.params.filename));
});

// ===== SMS HANDLER ENDPOINT =====

// GET endpoint for /sms - provides info page when accessed via browser
app.get('/sms', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SMS Webhook Endpoint</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .container {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 15px;
          padding: 30px;
          box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
        }
        h1 { margin-top: 0; }
        .status {
          background: rgba(76, 175, 80, 0.3);
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
        }
        .info {
          background: rgba(255, 255, 255, 0.1);
          padding: 15px;
          border-radius: 8px;
          margin: 15px 0;
        }
        code {
          background: rgba(0, 0, 0, 0.3);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Courier New', monospace;
        }
        ul { margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📱 SMS Webhook Endpoint</h1>

        <div class="status">
          <strong>✓ Status:</strong> Active and ready to receive SMS callbacks
        </div>

        <div class="info">
          <h3>📋 Endpoint Information</h3>
          <p><strong>Purpose:</strong> Receives SMS responses from Africa's Talking for medication adherence confirmations</p>
          <p><strong>Method:</strong> POST (webhooks only)</p>
          <p><strong>URL:</strong> <code>/sms</code></p>
        </div>

        <div class="info">
          <h3>🔧 Configuration</h3>
          <p>Set this URL in your Africa's Talking dashboard:</p>
          <p><strong>SMS Callback URL:</strong> <code>https://your-ngrok-url.ngrok-free.dev/sms</code></p>
        </div>

        <div class="info">
          <h3>📨 Accepted Keywords</h3>
          <p>Patients can reply with any of these keywords to confirm medication intake:</p>
          <ul>
            <li><code>YES</code></li>
            <li><code>Y</code></li>
            <li><code>TAKEN</code></li>
            <li><code>OK</code></li>
            <li><code>DONE</code></li>
            <li><code>CONFIRMED</code></li>
          </ul>
        </div>

        <div class="info">
          <h3>ℹ️ Note</h3>
          <p>This page appears because you accessed the endpoint via a browser (GET request). The actual SMS webhook uses POST requests sent by Africa's Talking.</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Process SMS responses for medication confirmations
app.post('/sms', async (req, res) => {
  console.log('--- SMS RECEIVED ---');
  console.log(JSON.stringify(req.body, null, 2));

  const { from, text, date } = req.body;

  if (!from || !text) {
    console.error('Invalid SMS request: missing from or text');
    return res.status(400).send('Invalid request');
  }

  const phoneNumber = from;
  const message = text.trim().toUpperCase();

  console.log(`SMS from ${phoneNumber}: "${message}"`);

  // Check if this is a medication confirmation (YES, Y, TAKEN, OK, DONE)
  const confirmationKeywords = ['YES', 'Y', 'TAKEN', 'OK', 'DONE', 'CONFIRMED'];
  const isConfirmation = confirmationKeywords.some(keyword => message === keyword);

  if (isConfirmation) {
    console.log('Processing medication confirmation...');

    // Fetch pending adherence logs for this phone number
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const pending = adherenceLog.filter(log => {
      const logDate = new Date(log.scheduledTime);
      logDate.setHours(0, 0, 0, 0);
      return log.status === 'pending' &&
             log.phoneNumber === phoneNumber &&
             logDate.getTime() === today.getTime();
    });

    if (pending.length === 0) {
      console.log('No pending medications found for this phone number');
      return res.status(200).send('No pending medication reminders found.');
    }

    console.log(`Found ${pending.length} pending medication(s)`);

    // Confirm the most recent pending medication
    const latestPending = pending.sort((a, b) =>
      new Date(b.scheduledTime) - new Date(a.scheduledTime)
    )[0];

    console.log(`Confirming medication: ${latestPending.medicationId}`);

    // Update the adherence log
    latestPending.status = 'taken';
    latestPending.takenAt = new Date().toISOString();
    latestPending.method = 'sms-confirmation';

    scheduleSave(); // Save to file

    console.log('Medication confirmed successfully');
    return res.status(200).send('Thank you! Medication confirmed.');
  }

  // If not a confirmation, just acknowledge
  console.log('SMS not recognized as medication confirmation');
  res.status(200).send('Message received. Reply YES to confirm medication intake.');
});

// ===== MEDICATION REMINDER SCHEDULER =====

// Send SMS reminder
async function sendWelcomeSMS(phoneNumber, patientName) {
  const message = `Welcome to Sickly Ignite! Thank you for registering with us. We're here to support your diabetes management journey. You can dial *384*39981# anytime to submit readings, manage medications, or get help. Stay healthy!`;

  console.log(`Sending welcome SMS to ${phoneNumber}`);

  try {
    const result = await sms.send({
      to: [phoneNumber],
      message,
      from: process.env.AT_SENDER_ID || null,
    });

    console.log('Welcome SMS sent successfully:', result);
    return result;
  } catch (error) {
    console.error('Failed to send welcome SMS:', error.message);
    return null;
  }
}

async function sendSMSReminder(phoneNumber, medicationName, dosage, time) {
  const message = `Medication Reminder: It's time to take your ${medicationName} (${dosage}). Reply YES to confirm you've taken it.`;

  console.log(`Sending SMS reminder to ${phoneNumber}: ${message}`);

  try {
    const result = await sms.send({
      to: [phoneNumber],
      message,
      from: process.env.AT_SENDER_ID || null,
    });

    console.log('SMS sent successfully:', result);
    return result;
  } catch (error) {
    console.error('Failed to send SMS:', error.message);
    return null;
  }
}

// Check medications and send reminders
async function checkAndSendReminders() {
  console.log('\n--- Checking for medication reminders ---');
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  console.log(`Current time: ${currentTime}`);

  const activeMedications = Array.from(medications.values()).filter(med => med.active);
  console.log(`Found ${activeMedications.length} active medications`);

  let remindersScheduled = 0;

  for (const medication of activeMedications) {
    // Check if any of the medication times match current time
    for (const scheduledTime of medication.times) {
      if (scheduledTime === currentTime) {
        console.log(`\n✓ Match found: ${medication.medicationName} for ${medication.phoneNumber} at ${scheduledTime}`);

        // Create adherence log entry
        const scheduledDateTime = new Date();
        scheduledDateTime.setHours(parseInt(scheduledTime.split(':')[0]));
        scheduledDateTime.setMinutes(parseInt(scheduledTime.split(':')[1]));
        scheduledDateTime.setSeconds(0);

        const adherenceRecord = {
          phoneNumber: medication.phoneNumber,
          medicationId: medication.id,
          scheduledTime: scheduledDateTime.toISOString(),
          takenAt: null,
          status: 'pending',
          method: 'sms-reminder',
          createdAt: new Date().toISOString()
        };

        adherenceLog.push(adherenceRecord);
        scheduleSave(); // Save to file

        console.log(`Created adherence log entry for ${medication.medicationName}`);

        // Send SMS reminder
        const smsResult = await sendSMSReminder(
          medication.phoneNumber,
          medication.medicationName,
          medication.dosage,
          scheduledTime
        );

        if (smsResult) {
          remindersScheduled++;
          console.log(`Reminder sent to ${medication.phoneNumber}`);
        }
      }
    }
  }

  console.log(`Total reminders sent: ${remindersScheduled}`);
  console.log('--- Check complete ---\n');
}

// Load data from files and start server
loadData().then(() => {
  app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║     Sickly Ignite - Unified Backend Server    ║`);
    console.log(`╚════════════════════════════════════════════════╝`);
    console.log(`\n✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Dashboard: http://localhost:${PORT}`);
    console.log(`✓ SMS webhook: http://localhost:${PORT}/sms`);
    console.log(`✓ Data directory: ${DATA_DIR}`);
    console.log(`\n🔔 Starting medication reminder scheduler...`);

    // Run initial check
    checkAndSendReminders();

    // Schedule reminder checks every minute
    cron.schedule('* * * * *', async () => {
      await checkAndSendReminders();
    });

    console.log(`✓ Reminder scheduler active (checks every minute)`);
    console.log(`\n════════════════════════════════════════════════\n`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down unified backend server...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\nShutting down unified backend server...');
    process.exit(0);
  });
}).catch(error => {
  console.error('Failed to load data:', error);
  process.exit(1);
});

// Export app for Vercel serverless deployment
module.exports = app;
