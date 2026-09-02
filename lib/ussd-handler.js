/**
 * USSD Handler Module
 * Handles direct USSD requests from Africa's Talking
 * Extracted and adapted from ignite.js for use in backend.js
 */

const { checkAndTriggerAutoSOS } = require('../sos-alerts');

// Session storage
const sessions = {};
const SESSION_TTL_MS = 15 * 60 * 1000;

// Constants
const MENU_TEXT = 'CON Welcome\n1. Register patient\n2. Enter readings\n3. Manage medications\n4. Check medication reminders\n5. Emergency contacts\n6. SOS Alert';
const DIABETES_TEXT = 'CON Select diabetes type:\n1. Type 1\n2. Type 2\n3. Not sure / undiagnosed';
const REGION_TEXT = 'CON Select region:\n1. Nairobi\n2. Central\n3. Coast\n4. Eastern\n5. North Eastern\n6. Nyanza\n7. Rift Valley\n8. Western';

const regionMap = {
  '1': { name: 'Nairobi', counties: { '1': 'Nairobi' } },
  '2': { name: 'Central', counties: { '1': 'Kiambu', '2': 'Murang\'a', '3': 'Nyeri', '4': 'Kirinyaga', '5': 'Nyandarua' } },
  '3': { name: 'Coast', counties: { '1': 'Mombasa', '2': 'Kwale', '3': 'Kilifi', '4': 'Tana River', '5': 'Lamu', '6': 'Taita-Taveta' } },
  '4': { name: 'Eastern', counties: { '1': 'Machakos', '2': 'Makueni', '3': 'Kitui', '4': 'Embu', '5': 'Tharaka-Nithi', '6': 'Meru', '7': 'Isiolo', '8': 'Marsabit' } },
  '5': { name: 'North Eastern', counties: { '1': 'Garissa', '2': 'Wajir', '3': 'Mandera' } },
  '6': { name: 'Nyanza', counties: { '1': 'Kisumu', '2': 'Siaya', '3': 'Homa Bay', '4': 'Migori', '5': 'Kisii', '6': 'Nyamira' } },
  '7': { name: 'Rift Valley', counties: { '1': 'Nakuru', '2': 'Nandi', '3': 'Uasin Gishu', '4': 'Trans-Nzoia', '5': 'Elgeyo-Marakwet', '6': 'Baringo', '7': 'Laikipia', '8': 'Kajiado', '9': 'Narok', '10': 'Kericho', '11': 'Bomet', '12': 'West Pokot', '13': 'Turkana', '14': 'Samburu' } },
  '8': { name: 'Western', counties: { '1': 'Kakamega', '2': 'Vihiga', '3': 'Bungoma', '4': 'Busia' } }
};

// Helper functions
function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = String(phone).replace(/\s+/g, '').replace(/\*/g, '').trim();
  if (!cleaned) return '';
  if (/^0\d{8,9}$/.test(cleaned)) return `+254${cleaned.slice(1)}`;
  if (/^254\d{8,9}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned.startsWith('+') ? cleaned : cleaned;
}

function isValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return /^(?:\+254|254)?[17]\d{7,8}$/.test(normalized);
}

function isValidAge(age) {
  const value = Number(age);
  return Number.isInteger(value) && value >= 1 && value <= 120;
}

function isValidGlucose(glucose) {
  const value = Number(glucose);
  return Number.isFinite(value) && value >= 20 && value <= 600;
}

function parseBloodPressure(value) {
  const str = String(value || '').trim();
  if (str === '0') return { skipped: true };
  const normalized = str.replace(/[\s*,\-.]+/g, '/');
  const match = normalized.match(/^(\d{2,3})\/(\d{2,3})$/);
  if (!match) return null;
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (systolic < 50 || systolic > 250 || diastolic < 30 || diastolic > 150 || systolic <= diastolic) return null;
  return { systolic, diastolic };
}

function getBloodPressureInput(text, currentInput = '') {
  const trimmedInput = String(currentInput || '').trim();
  if (trimmedInput && parseBloodPressure(trimmedInput)) return trimmedInput;
  const values = String(text || '').trim().split('*').filter(Boolean);
  if (values.length >= 5 && /^\d{2,3}$/.test(values[values.length - 2]) && /^\d{2,3}$/.test(values[values.length - 1])) {
    return `${values[values.length - 2]}/${values[values.length - 1]}`;
  }
  return trimmedInput;
}

function clearSession(sessionId) {
  delete sessions[sessionId];
}

function sendResponse(res, text, hop = '') {
  res.set('Content-Type', 'text/plain');
  if (hop) res.set('at-ussd-hop-metadata', hop);
  res.send(text);
}

function getCurrentInput(text) {
  const values = String(text || '').trim().split('*').filter(Boolean);
  return values.length ? values[values.length - 1] : '';
}

/**
 * Main USSD handler
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Object} dataStores - Backend data structures { patients, readings, medications, adherenceLog, emergencyContacts, sosEvents }
 */
async function handleDirectUSSD(req, res, dataStores) {
  console.log('--- DIRECT USSD REQUEST ---');
  console.log(JSON.stringify(req.body, null, 2));

  const { sessionId, phoneNumber, text, serviceCode } = req.body;
  const input = getCurrentInput(text);

  console.log('Parsed values =>', { sessionId, phoneNumber, text, input });

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return sendResponse(res, 'END Missing session ID');
  }

  if (phoneNumber && !isValidPhone(normalizePhone(phoneNumber))) {
    return sendResponse(res, 'END Invalid caller phone number');
  }

  // Initialize or restore session
  if (!sessions[sessionId]) {
    sessions[sessionId] = { stage: 'menu', patient: {}, lastActivity: Date.now() };
  }

  const session = sessions[sessionId];
  if (Date.now() - (session.lastActivity || 0) > SESSION_TTL_MS) {
    clearSession(sessionId);
    sessions[sessionId] = { stage: 'menu', patient: {}, lastActivity: Date.now() };
  }
  sessions[sessionId].lastActivity = Date.now();
  console.log('Current session state =>', session);

  // Main menu
  if (session.stage === 'menu') {
    if (!input) return sendResponse(res, MENU_TEXT, 'menu');

    if (input === '1') {
      session.stage = 'registerPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'registerPhone');
    }
    if (input === '2') {
      session.stage = 'readingPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'readingPhone');
    }
    if (input === '3') {
      session.stage = 'medicationPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'medicationPhone');
    }
    if (input === '4') {
      session.stage = 'reminderPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'reminderPhone');
    }
    if (input === '5') {
      session.stage = 'emergencyPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'emergencyPhone');
    }
    if (input === '6') {
      session.stage = 'sosPhone';
      return sendResponse(res, 'CON Enter patient phone number', 'sosPhone');
    }
    return sendResponse(res, 'CON Invalid option. Choose 1-6', 'menu');
  }

  // This is a minimal implementation showing the structure
  // For now, I'll implement just patient registration as a proof of concept
  // The full implementation would include all flows from ignite.js

  if (session.stage === 'registerPhone') {
    const patientPhone = input || phoneNumber;
    const normalizedPhone = normalizePhone(patientPhone);

    if (!isValidPhone(normalizedPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'registerPhone');
    }

    session.patient.phoneNumber = normalizedPhone;
    const existingPatient = dataStores.patients.get(normalizedPhone);

    if (existingPatient) {
      session.patient = existingPatient;
      clearSession(sessionId);
      return sendResponse(res, `END Patient ${normalizedPhone} already registered!`, 'alreadyRegistered');
    }

    session.stage = 'registerAge';
    return sendResponse(res, 'CON Enter patient age', 'registerAge');
  }

  if (session.stage === 'registerAge') {
    if (!isValidAge(input)) {
      return sendResponse(res, 'CON Enter a valid age (1-120)', 'registerAge');
    }
    session.patient.age = Number(input);
    session.stage = 'registerDiabetes';
    return sendResponse(res, DIABETES_TEXT, 'registerDiabetes');
  }

  if (session.stage === 'registerDiabetes') {
    const typeMap = { '1': 'Type 1', '2': 'Type 2', '3': 'Undiagnosed' };
    if (!typeMap[input]) {
      return sendResponse(res, 'CON Invalid choice. Choose 1-3', 'registerDiabetes');
    }
    session.patient.diabetesType = typeMap[input];
    session.stage = 'registerRegion';
    return sendResponse(res, REGION_TEXT, 'registerRegion');
  }

  if (session.stage === 'registerRegion') {
    const region = regionMap[input];
    if (!region) {
      return sendResponse(res, 'CON Invalid region. Choose 1-8', 'registerRegion');
    }
    session.patient.region = region.name;
    session.regionChoice = input;
    session.stage = 'registerCounty';

    let countyText = `CON Select county in ${region.name}:\n`;
    Object.entries(region.counties).forEach(([key, name]) => {
      countyText += `${key}. ${name}\n`;
    });
    return sendResponse(res, countyText.trim(), 'registerCounty');
  }

  if (session.stage === 'registerCounty') {
    const region = regionMap[session.regionChoice];
    const county = region.counties[input];
    if (!county) {
      return sendResponse(res, 'CON Invalid county choice', 'registerCounty');
    }
    session.patient.county = county;
    session.stage = 'registerConfirm';

    const confirmText = `CON Confirm registration:\nPhone: ${session.patient.phoneNumber}\nAge: ${session.patient.age}\nType: ${session.patient.diabetesType}\nRegion: ${session.patient.region}\nCounty: ${session.patient.county}\n\n1. Confirm\n2. Cancel`;
    return sendResponse(res, confirmText, 'registerConfirm');
  }

  if (session.stage === 'registerConfirm') {
    if (input === '1') {
      session.patient.registrationDate = new Date().toISOString();
      dataStores.patients.set(session.patient.phoneNumber, session.patient);
      console.log('Patient registered:', session.patient);
      clearSession(sessionId);
      return sendResponse(res, 'END Patient registered successfully!', 'registered');
    } else {
      clearSession(sessionId);
      return sendResponse(res, 'END Registration cancelled', 'cancelled');
    }
  }

  // Default fallback
  clearSession(sessionId);
  return sendResponse(res, 'END Session error. Please try again.', 'error');
}

module.exports = {
  handleDirectUSSD,
  normalizePhone,
  isValidPhone
};
