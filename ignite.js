const express = require('express');
const bodyParser = require('body-parser');
const { checkAndTriggerAutoSOS } = require('./sos-alerts');

const app = express();
const PORT = 3000;
const BACKEND_URL = 'http://127.0.0.1:8000/ussd';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const sessions = {};
// Local cache only for fast session continuity in the current Node process.
// The backend is the authoritative data store.
const patients = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

const MENU_TEXT = 'CON Welcome\n1. Register patient\n2. Enter readings\n3. Manage medications\n4. Check medication reminders\n5. Emergency contacts\n6. SOS Alert';
const DIABETES_TEXT = 'CON Select diabetes type:\n1. Type 1\n2. Type 2\n3. Not sure / undiagnosed';
const REGION_TEXT = 'CON Select region:\n1. Nairobi\n2. Central\n3. Coast\n4. Eastern\n5. North Eastern\n6. Nyanza\n7. Rift Valley\n8. Western';

function normalizePhone(phone) {
  if (!phone) return '';

  const cleaned = String(phone).replace(/\s+/g, '').replace(/\*/g, '').trim();
  if (!cleaned) return '';

  if (/^0\d{8,9}$/.test(cleaned)) {
    return `+254${cleaned.slice(1)}`;
  }

  if (/^254\d{8,9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

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
  if (systolic < 50 || systolic > 250 || diastolic < 30 || diastolic > 150 || systolic <= diastolic) {
    return null;
  }

  return { systolic, diastolic };
}

function getBloodPressureInput(text, currentInput = '') {
  const trimmedInput = String(currentInput || '').trim();

  // If currentInput itself can be parsed directly (or is '0'), use it
  if (trimmedInput && parseBloodPressure(trimmedInput)) {
    return trimmedInput;
  }

  const values = String(text || '')
    .trim()
    .split('*')
    .filter(Boolean);

  // In readings flow: [0: menu option, 1: phone, 2: glucose, 3+: blood pressure entries]
  // Only combine the last two values if both are entered at or after the blood pressure stage (index >= 3)
  if (
    values.length >= 5 &&
    /^\d{2,3}$/.test(values[values.length - 2]) &&
    /^\d{2,3}$/.test(values[values.length - 1])
  ) {
    return `${values[values.length - 2]}/${values[values.length - 1]}`;
  }

  return trimmedInput;
}

function clearSession(sessionId) {
  delete sessions[sessionId];
}

function parseBackendResponseText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

async function postEventToBackend(eventName, payload) {
  const payloadText = JSON.stringify({ event: eventName, ...payload });

  const result = await sendToBackend({
    sessionId: payload.sessionId || 'frontend-session',
    serviceCode: payload.serviceCode || 'AFYALINK',
    phoneNumber: payload.phoneNumber || '',
    text: payloadText,
  });

  return {
    ...result,
    parsed: parseBackendResponseText(result.result),
  };
}

async function lookupPatientInBackend(phoneNumber) {
  const normalizedPhone = normalizePhone(phoneNumber);

  if (!normalizedPhone) {
    return { ok: false, reason: 'missing_phone' };
  }

  const result = await postEventToBackend('patient_lookup', {
    sessionId: `lookup_${normalizedPhone}`,
    serviceCode: 'AFYALINK',
    phoneNumber: normalizedPhone,
    patient: { phoneNumber: normalizedPhone },
  });

  if (!result.ok) {
    return { ok: false, reason: 'backend_error', detail: result };
  }

  const backendText = String(result.result || '').trim();

  if (!backendText || /unknown event payload|not found|patient not found/i.test(backendText)) {
    return { ok: false, reason: 'not_found', detail: backendText };
  }

  try {
    const parsed = JSON.parse(backendText);
    if (parsed && parsed.patient) {
      return { ok: true, patient: parsed.patient };
    }
    return { ok: true, patient: null };
  } catch (error) {
    return { ok: true, patient: null, detail: backendText };
  }
}

const regionMap = {
  '1': {
    name: 'Nairobi',
    counties: {
      '1': 'Nairobi',
    },
  },
  '2': {
    name: 'Central',
    counties: {
      '1': 'Kiambu',
      '2': 'Murang\'a',
      '3': 'Nyeri',
      '4': 'Kirinyaga',
      '5': 'Nyandarua',
    },
  },
  '3': {
    name: 'Coast',
    counties: {
      '1': 'Mombasa',
      '2': 'Kwale',
      '3': 'Kilifi',
      '4': 'Tana River',
      '5': 'Lamu',
      '6': 'Taita-Taveta',
    },
  },
  '4': {
    name: 'Eastern',
    counties: {
      '1': 'Machakos',
      '2': 'Makueni',
      '3': 'Kitui',
      '4': 'Embu',
      '5': 'Tharaka-Nithi',
      '6': 'Meru',
      '7': 'Isiolo',
      '8': 'Marsabit',
    },
  },
  '5': {
    name: 'North Eastern',
    counties: {
      '1': 'Garissa',
      '2': 'Wajir',
      '3': 'Mandera',
    },
  },
  '6': {
    name: 'Nyanza',
    counties: {
      '1': 'Kisumu',
      '2': 'Siaya',
      '3': 'Homa Bay',
      '4': 'Migori',
      '5': 'Kisii',
      '6': 'Nyamira',
    },
  },
  '7': {
    name: 'Rift Valley',
    counties: {
      '1': 'Nakuru',
      '2': 'Nandi',
      '3': 'Uasin Gishu',
      '4': 'Trans-Nzoia',
      '5': 'Elgeyo-Marakwet',
      '6': 'Baringo',
      '7': 'Laikipia',
      '8': 'Kajiado',
      '9': 'Narok',
      '10': 'Kericho',
      '11': 'Bomet',
      '12': 'West Pokot',
      '13': 'Turkana',
      '14': 'Samburu',
    },
  },
  '8': {
    name: 'Western',
    counties: {
      '1': 'Kakamega',
      '2': 'Vihiga',
      '3': 'Bungoma',
      '4': 'Busia',
    },
  },
};

function sendResponse(res, text, hop = '') {
  res.set('Content-Type', 'text/plain');
  if (hop) {
    res.set('at-ussd-hop-metadata', hop);
  }
  res.send(text);
}

function getCurrentInput(text) {
  const values = String(text || '')
    .trim()
    .split('*')
    .filter(Boolean);

  return values.length ? values[values.length - 1] : '';
}

async function sendToBackend(payload) {
  try {
    const body = new URLSearchParams();

    Object.entries(payload).forEach(([key, value]) => {
      body.append(key, String(value));
    });

    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const result = await response.text();
    console.log('Backend response:', response.status, result);
    return { ok: response.ok, status: response.status, result };
  } catch (error) {
    console.error('Backend send failed:', error.message);
    return { ok: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.status(200).send('USSD server is running');
});

app.get('/ussd', (req, res) => {
  res.status(200).send('USSD endpoint ready');
});

app.post('/ussd', async (req, res) => {
  console.log('--- USSD REQUEST ---');
  console.log(JSON.stringify(req.body, null, 2));

  const { sessionId, phoneNumber, text } = req.body;
  const input = getCurrentInput(text);

  console.log('Parsed values =>', { sessionId, phoneNumber, text, input });

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return sendResponse(res, 'END Missing session ID');
  }

  if (phoneNumber && !isValidPhone(normalizePhone(phoneNumber))) {
    return sendResponse(res, 'END Invalid caller phone number');
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      stage: 'menu',
      patient: {},
      lastActivity: Date.now(),
    };
  }

  const session = sessions[sessionId];
  if (Date.now() - (session.lastActivity || 0) > SESSION_TTL_MS) {
    clearSession(sessionId);
    sessions[sessionId] = { stage: 'menu', patient: {}, lastActivity: Date.now() };
  }
  sessions[sessionId].lastActivity = Date.now();
  console.log('Current session state =>', session);

  if (session.stage === 'menu') {
    if (!input) {
      return sendResponse(
        res,
        'CON Welcome\n1. Register patient\n2. Enter readings\n3. Manage medications\n4. Check medication reminders\n5. Emergency contacts\n6. SOS Alert',
        'menu'
      );
    }

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

  console.log('Next stage =>', session.stage);

  if (session.stage === 'registerPhone') {
    const patientPhone = input || phoneNumber;

    const normalizedPhone = normalizePhone(patientPhone);
    if (!isValidPhone(normalizedPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'registerPhone');
    }

    session.patient.phoneNumber = normalizedPhone;

    let existingPatient = patients.get(normalizedPhone);
    if (!existingPatient) {
      const backendLookup = await lookupPatientInBackend(normalizedPhone);
      if (backendLookup.reason === 'backend_error') {
        return sendResponse(res, 'END Please try again later.', 'backendError');
      }
      existingPatient = backendLookup.patient;
      if (existingPatient) patients.set(normalizedPhone, existingPatient);
    }

    if (existingPatient) {
      session.patient = existingPatient;
      session.stage = 'existingPatient';
      return sendResponse(
        res,
        'CON Patient already registered. Continue to reading? 1. Yes',
        'existingPatient'
      );
    }

    session.stage = 'age';
    return sendResponse(res, 'CON Enter patient age', 'age');
  }

  if (session.stage === 'existingPatient') {
    if (input === '1') {
      const patient = patients.get(session.patient.phoneNumber);

      if (patient) {
        session.patient = patient;
        session.stage = 'glucose';
        return sendResponse(
          res,
          `CON Patient found\nAge: ${patient.age}\nType: ${patient.diabetesType}\nRegion: ${patient.region}\nCounty: ${patient.county}\nEnter glucose reading`,
          'glucose'
        );
      }

      session.stage = 'readingPhone';
      return sendResponse(
        res,
        'CON Enter patient phone number to continue reading',
        'readingPhone'
      );
    }

    return sendResponse(res, 'END Registration cancelled', 'cancelled');
  }

  if (session.stage === 'age') {
    if (!isValidAge(input)) {
      return sendResponse(res, 'CON Enter a valid patient age', 'age');
    }

    session.patient.age = Number(input);
    session.stage = 'diabetesType';
    return sendResponse(
      res,
      'CON Select diabetes type:\n1. Type 1\n2. Type 2\n3. Not sure / undiagnosed',
      'diabetesType'
    );
  }

  if (session.stage === 'diabetesType') {
    const diabetesMap = {
      '1': 'Type 1',
      '2': 'Type 2',
      '3': 'Not sure / undiagnosed',
    };

    if (!diabetesMap[input]) {
      return sendResponse(
        res,
        'CON Invalid option. Select diabetes type:\n1. Type 1\n2. Type 2\n3. Not sure / undiagnosed',
        'diabetesType'
      );
    }

    session.patient.diabetesType = diabetesMap[input];
    session.stage = 'region';
    return sendResponse(
      res,
      'CON Select region:\n1. Nairobi\n2. Central\n3. Coast\n4. Eastern\n5. North Eastern\n6. Nyanza\n7. Rift Valley\n8. Western',
      'region'
    );
  }

  if (session.stage === 'region') {
    const selectedRegion = regionMap[input];

    if (!selectedRegion) {
      return sendResponse(
        res,
        'CON Invalid region. Select region:\n1. Nairobi\n2. Central\n3. Coast\n4. Eastern\n5. North Eastern\n6. Nyanza\n7. Rift Valley\n8. Western',
        'region'
      );
    }

    session.patient.region = selectedRegion.name;
    session.stage = 'county';

    const countyOptions = Object.entries(selectedRegion.counties)
      .map(([key, value]) => `${key}. ${value}`)
      .join('\n');

    return sendResponse(
      res,
      `CON Select ${selectedRegion.name} county:\n${countyOptions}`,
      'county'
    );
  }

  if (session.stage === 'county') {
    const region = regionMap[Object.keys(regionMap).find((key) => regionMap[key].name === session.patient.region)];
    const selectedCounty = region && region.counties[input];

    if (!selectedCounty) {
      const countyOptions = Object.entries(region.counties)
        .map(([key, value]) => `${key}. ${value}`)
        .join('\n');

      return sendResponse(
        res,
        `CON Invalid county. Select ${session.patient.region} county:\n${countyOptions}`,
        'county'
      );
    }

    session.patient.county = selectedCounty;
    session.stage = 'confirm';

    return sendResponse(
      res,
      `CON Please confirm:\nPhone: ${session.patient.phoneNumber}\nAge: ${session.patient.age}\nDiabetes: ${session.patient.diabetesType}\nRegion: ${session.patient.region}\nCounty: ${session.patient.county}\n1. Confirm\n2. Cancel`,
      'confirm'
    );
  }

  if (session.stage === 'confirm') {
    if (input === '1') {
      patients.set(session.patient.phoneNumber, session.patient);

      const savedPatient = {
        ...session.patient,
        savedAt: new Date().toISOString(),
      };

      // Persist to backend as the authoritative store and keep a local cache only
      // for the current session flow.
      const backendRegistration = await postEventToBackend('patient_registered', {
        sessionId,
        serviceCode: 'AFYALINK',
        phoneNumber: session.patient.phoneNumber,
        patient: savedPatient,
      });

      if (!backendRegistration.ok || !/^END /.test(String(backendRegistration.result || ''))) {
        clearSession(sessionId);
        return sendResponse(
          res,
          'END Please try again later.',
          'backendError'
        );
      }

      patients.set(session.patient.phoneNumber, savedPatient);

      clearSession(sessionId);

      return sendResponse(
        res,
        'END Patient saved successfully. You can now continue to readings.',
        'saved'
      );
    }

    if (input === '2') {
      return sendResponse(res, 'END Registration cancelled', 'cancelled');
    }

    return sendResponse(res, 'CON Please choose 1 to confirm or 2 to cancel', 'confirm');
  }

  if (session.stage === 'readingPhone') {
    const patientPhone = normalizePhone(input || phoneNumber);

    if (!isValidPhone(patientPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'readingPhone');
    }

    const patient = patients.get(patientPhone) || null;

    if (!patient) {
      const backendLookup = await lookupPatientInBackend(patientPhone);

      if (backendLookup.ok && backendLookup.patient) {
        patients.set(patientPhone, backendLookup.patient);
        session.patient = backendLookup.patient;
        session.stage = 'glucose';

        return sendResponse(
          res,
          `CON Patient found\nAge: ${backendLookup.patient.age}\nType: ${backendLookup.patient.diabetesType}\nRegion: ${backendLookup.patient.region}\nCounty: ${backendLookup.patient.county}\nEnter glucose reading`,
          'glucose'
        );
      }
    }

    if (!patient) {
      return sendResponse(
        res,
        'END Patient not found. Please register the patient first.',
        'notFound'
      );
    }

    session.patient = patient;
    session.stage = 'glucose';

    return sendResponse(
      res,
      `CON Patient found\nAge: ${patient.age}\nType: ${patient.diabetesType}\nRegion: ${patient.region}\nCounty: ${patient.county}\nEnter glucose reading`,
      'glucose'
    );
  }

  if (session.stage === 'glucose') {
    if (!isValidGlucose(input)) {
      return sendResponse(res, 'CON Enter a valid glucose reading', 'glucose');
    }

    session.glucose = Number(input);
    session.stage = 'bloodPressure';
    return sendResponse(
      res,
      'CON Enter blood pressure (e.g. 120/80) or 0 to skip',
      'bloodPressure'
    );
  }

  if (session.stage === 'bloodPressure') {
    const bloodPressureInput = getBloodPressureInput(text, input);
    const bloodPressure = parseBloodPressure(bloodPressureInput);
    if (!bloodPressure) {
      return sendResponse(
        res,
        'CON Enter a valid blood pressure such as 120/80, or 0 to skip',
        'bloodPressure'
      );
    }

    session.bloodPressure = bloodPressure.skipped
      ? 'Skipped'
      : `${bloodPressure.systolic}/${bloodPressure.diastolic}`;
    session.stage = 'readingConfirm';

    return sendResponse(
      res,
      `CON Please confirm:\nGlucose: ${session.glucose}\nBlood Pressure: ${session.bloodPressure}\n1. Save\n2. Cancel`,
      'readingConfirm'
    );
  }

  if (session.stage === 'readingConfirm') {
    if (input === '1') {
      const reading = {
        phoneNumber: session.patient.phoneNumber,
        age: session.patient.age,
        diabetesType: session.patient.diabetesType,
        region: session.patient.region,
        county: session.patient.county,
        glucose: session.glucose,
        bloodPressure: session.bloodPressure,
        recordedAt: new Date().toISOString(),
      };

      const backendReading = await postEventToBackend('reading_saved', {
        sessionId,
        serviceCode: 'AFYALINK',
        phoneNumber: session.patient.phoneNumber,
        reading,
      });

      if (!backendReading.ok || !/^END /.test(String(backendReading.result || ''))) {
        clearSession(sessionId);
        return sendResponse(
          res,
          'END Please try again later.',
          'backendError'
        );
      }

      // Check for dangerous glucose levels and trigger auto-SOS if needed
      const sosResult = await checkAndTriggerAutoSOS(
        session.patient.phoneNumber,
        session.glucose,
        `${session.patient.county}, ${session.patient.region}`
      );

      clearSession(sessionId);

      if (sosResult) {
        return sendResponse(
          res,
          'END ⚠️ CRITICAL: Your glucose level is dangerous. SOS alert sent to emergency contacts. Please seek immediate medical attention!',
          'criticalReading'
        );
      }

      return sendResponse(
        res,
        'END Reading saved successfully. Advice will be generated shortly.',
        'readingSaved'
      );
    }

    if (input === '2') {
      return sendResponse(res, 'END Reading cancelled', 'cancelled');
    }

    return sendResponse(res, 'CON Please choose 1 to save or 2 to cancel', 'readingConfirm');
  }

  // Medication Management Flow
  if (session.stage === 'medicationPhone') {
    const patientPhone = normalizePhone(input || phoneNumber);

    if (!isValidPhone(patientPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'medicationPhone');
    }

    const patient = patients.get(patientPhone) || null;

    if (!patient) {
      const backendLookup = await lookupPatientInBackend(patientPhone);

      if (backendLookup.ok && backendLookup.patient) {
        patients.set(patientPhone, backendLookup.patient);
        session.patient = backendLookup.patient;
      } else {
        return sendResponse(
          res,
          'END Patient not found. Please register the patient first.',
          'notFound'
        );
      }
    } else {
      session.patient = patient;
    }

    session.stage = 'medicationMenu';
    return sendResponse(
      res,
      'CON Medication Management\n1. Add new medication\n2. View my medications\n\nSet up reminders for your meds',
      'medicationMenu'
    );
  }

  if (session.stage === 'medicationMenu') {
    if (input === '1') {
      session.stage = 'medicationName';
      return sendResponse(res, 'CON Enter medication name\n(e.g., Metformin, Insulin)\n0. Cancel', 'medicationName');
    }

    if (input === '2') {
      // Fetch medications from backend
      try {
        const response = await fetch(`http://127.0.0.1:8000/api/medications/${session.patient.phoneNumber}`);
        const medications = await response.json();

        if (!medications || medications.length === 0) {
          return sendResponse(res, 'END No medications found. Add one using option 3 from main menu.', 'noMedications');
        }

        const medList = medications
          .filter(med => med.active)
          .map((med, idx) => `${idx + 1}. ${med.name} - ${med.dosage} (${med.frequency})`)
          .join('\n');

        clearSession(sessionId);
        return sendResponse(res, `END Your Medications:\n${medList}`, 'medicationsList');
      } catch (error) {
        console.error('Failed to fetch medications:', error);
        return sendResponse(res, 'END Could not retrieve medications. Please try again later.', 'error');
      }
    }

    return sendResponse(res, 'CON Invalid option. Choose 1 or 2', 'medicationMenu');
  }

  if (session.stage === 'medicationName') {
    if (input === '0') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication entry cancelled', 'cancelled');
    }

    if (!input || input.length < 2) {
      return sendResponse(res, 'CON Enter medication name (e.g., Metformin, Insulin)\nOr 0 to cancel', 'medicationName');
    }

    session.medication = { name: input };
    session.stage = 'medicationDosage';
    return sendResponse(res, 'CON Enter dosage (e.g., 500mg, 10ml, 2 tablets)\nOr 0 to cancel', 'medicationDosage');
  }

  if (session.stage === 'medicationDosage') {
    if (input === '0') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication entry cancelled', 'cancelled');
    }

    if (!input || input.length < 2) {
      return sendResponse(res, 'CON Enter valid dosage (e.g., 500mg, 10ml, 2 tablets)\nOr 0 to cancel', 'medicationDosage');
    }

    session.medication.dosage = input;
    session.stage = 'medicationFrequency';
    return sendResponse(
      res,
      'CON How often per day?\n1. Once daily (e.g., morning)\n2. Twice daily (e.g., morning & evening)\n3. Three times daily\n4. Custom times\n0. Cancel',
      'medicationFrequency'
    );
  }

  if (session.stage === 'medicationFrequency') {
    if (input === '0') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication entry cancelled', 'cancelled');
    }

    const frequencyMap = {
      '1': { text: 'once', count: 1, suggestion: 'Enter time (e.g., 08:00 for morning)' },
      '2': { text: 'twice', count: 2, suggestion: 'Enter first time (e.g., 08:00 for morning)' },
      '3': { text: 'thrice', count: 3, suggestion: 'Enter first time (e.g., 07:00)' },
      '4': { text: 'custom', count: 0, suggestion: '' },
    };

    if (!frequencyMap[input]) {
      return sendResponse(
        res,
        'CON Invalid option. Choose 1-4\n1. Once daily\n2. Twice daily\n3. Three times daily\n4. Custom times\n0. Cancel',
        'medicationFrequency'
      );
    }

    session.medication.frequency = frequencyMap[input].text;
    session.medication.timeCount = frequencyMap[input].count;
    session.medication.times = [];
    session.stage = 'medicationTime1';

    if (input === '4') {
      return sendResponse(res, 'CON How many times per day? (1-6)\n0. Cancel', 'medicationCustomCount');
    }

    return sendResponse(
      res,
      `CON ${frequencyMap[input].suggestion}\n(24hr format)\n0. Cancel`,
      'medicationTime1'
    );
  }

  if (session.stage === 'medicationCustomCount') {
    if (input === '0') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication entry cancelled', 'cancelled');
    }

    const count = Number(input);
    if (!Number.isInteger(count) || count < 1 || count > 6) {
      return sendResponse(res, 'CON Enter a valid number between 1-6\n0. Cancel', 'medicationCustomCount');
    }

    session.medication.timeCount = count;
    session.stage = 'medicationTime1';
    return sendResponse(res, 'CON Enter time 1 (24hr format, e.g., 08:00)\n0. Cancel', 'medicationTime1');
  }

  // Handle medication time entries
  const timeStageMatch = session.stage.match(/^medicationTime(\d+)$/);
  if (timeStageMatch) {
    const timeNumber = parseInt(timeStageMatch[1]);

    if (input === '0') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication entry cancelled', 'cancelled');
    }

    // Validate time format (HH:MM)
    if (!/^\d{1,2}:\d{2}$/.test(input)) {
      const examples = ['08:00', '13:00', '20:00'];
      return sendResponse(
        res,
        `CON Invalid format. Enter time ${timeNumber} as HH:MM\nExamples: ${examples[timeNumber - 1] || '08:00'}\n0. Cancel`,
        session.stage
      );
    }

    const [hours, minutes] = input.split(':').map(Number);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return sendResponse(
        res,
        `CON Time must be 00:00-23:59\nEnter time ${timeNumber} (e.g., 08:00)\n0. Cancel`,
        session.stage
      );
    }

    // Store the time (ensure HH:MM format)
    const formattedTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    session.medication.times.push(formattedTime);

    // Check if we need more times
    if (timeNumber < session.medication.timeCount) {
      session.stage = `medicationTime${timeNumber + 1}`;
      // Suggest times based on position
      const suggestions = {
        2: '13:00 (afternoon)',
        3: '20:00 (evening)',
        4: '22:00 (night)',
      };
      const suggestion = suggestions[timeNumber + 1] || `${(timeNumber + 1) * 6}:00`;
      return sendResponse(
        res,
        `CON Enter time ${timeNumber + 1}\n(e.g., ${suggestion})\n0. Cancel`,
        session.stage
      );
    }

    // All times collected, move to confirmation
    session.stage = 'medicationConfirm';
    const timesList = session.medication.times.join(', ');
    return sendResponse(
      res,
      `CON Confirm medication:\nName: ${session.medication.name}\nDosage: ${session.medication.dosage}\nFrequency: ${session.medication.frequency}\nTimes: ${timesList}\n1. Confirm\n2. Cancel`,
      'medicationConfirm'
    );
  }

  if (session.stage === 'medicationConfirm') {
    if (input === '1') {
      // Save medication to backend
      const medicationData = {
        phoneNumber: session.patient.phoneNumber,
        name: session.medication.name,
        dosage: session.medication.dosage,
        frequency: session.medication.frequency,
        times: session.medication.times,
        startDate: new Date().toISOString(),
      };

      try {
        const response = await fetch('http://127.0.0.1:8000/api/medications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(medicationData),
        });

        if (!response.ok) {
          throw new Error('Backend save failed');
        }

        const result = await response.json();
        clearSession(sessionId);
        return sendResponse(
          res,
          `END Medication "${session.medication.name}" saved successfully. You will receive reminders at the scheduled times.`,
          'medicationSaved'
        );
      } catch (error) {
        console.error('Failed to save medication:', error);
        clearSession(sessionId);
        return sendResponse(res, 'END Could not save medication. Please try again later.', 'error');
      }
    }

    if (input === '2') {
      clearSession(sessionId);
      return sendResponse(res, 'END Medication not saved', 'cancelled');
    }

    return sendResponse(res, 'CON Please choose 1 to confirm or 2 to cancel', 'medicationConfirm');
  }

  // Check Medication Reminders Flow
  if (session.stage === 'reminderPhone') {
    const patientPhone = normalizePhone(input || phoneNumber);

    if (!isValidPhone(patientPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'reminderPhone');
    }

    const patient = patients.get(patientPhone) || null;

    if (!patient) {
      const backendLookup = await lookupPatientInBackend(patientPhone);

      if (!backendLookup.ok || !backendLookup.patient) {
        return sendResponse(
          res,
          'END Patient not found. Please register the patient first.',
          'notFound'
        );
      }
      patients.set(patientPhone, backendLookup.patient);
      session.patient = backendLookup.patient;
    } else {
      session.patient = patient;
    }

    // Fetch medications and today's schedule
    try {
      const response = await fetch(`http://127.0.0.1:8000/api/medications/${patientPhone}`);
      const medications = await response.json();

      if (!medications || medications.length === 0) {
        clearSession(sessionId);
        return sendResponse(res, 'END No medications found. Add medications using option 3 from main menu.', 'noMedications');
      }

      const activeMeds = medications.filter(med => med.active);

      if (activeMeds.length === 0) {
        clearSession(sessionId);
        return sendResponse(res, 'END No active medications found.', 'noActiveMedications');
      }

      // Build today's schedule
      const schedule = [];
      activeMeds.forEach(med => {
        med.times.forEach(time => {
          schedule.push({ time, name: med.name, dosage: med.dosage });
        });
      });

      // Sort by time
      schedule.sort((a, b) => a.time.localeCompare(b.time));

      const scheduleText = schedule
        .map(item => `${item.time} - ${item.name} (${item.dosage})`)
        .join('\n');

      clearSession(sessionId);
      return sendResponse(
        res,
        `END Today's Medication Schedule:\n${scheduleText}\n\nReply YES via SMS when you take each dose.`,
        'reminderSchedule'
      );
    } catch (error) {
      console.error('Failed to fetch reminders:', error);
      clearSession(sessionId);
      return sendResponse(res, 'END Could not retrieve reminders. Please try again later.', 'error');
    }
  }

  // Emergency Contacts Management Flow
  if (session.stage === 'emergencyPhone') {
    const patientPhone = normalizePhone(input || phoneNumber);

    if (!isValidPhone(patientPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'emergencyPhone');
    }

    const patient = patients.get(patientPhone) || null;

    if (!patient) {
      const backendLookup = await lookupPatientInBackend(patientPhone);

      if (!backendLookup.ok || !backendLookup.patient) {
        return sendResponse(
          res,
          'END Patient not found. Please register the patient first.',
          'notFound'
        );
      }
      patients.set(patientPhone, backendLookup.patient);
      session.patient = backendLookup.patient;
    } else {
      session.patient = patient;
    }

    session.stage = 'emergencyMenu';
    return sendResponse(
      res,
      'CON Emergency Contacts\n1. Add contact\n2. View contacts',
      'emergencyMenu'
    );
  }

  if (session.stage === 'emergencyMenu') {
    if (input === '1') {
      session.stage = 'emergencyContactName';
      return sendResponse(res, 'CON Enter contact name', 'emergencyContactName');
    }

    if (input === '2') {
      // Fetch emergency contacts from backend
      try {
        const response = await fetch(`http://127.0.0.1:8000/api/emergency-contacts/${session.patient.phoneNumber}`);
        const contacts = await response.json();

        if (!contacts || contacts.length === 0) {
          return sendResponse(res, 'END No emergency contacts found. Add one using option 5 from main menu.', 'noContacts');
        }

        const contactList = contacts
          .sort((a, b) => a.priority - b.priority)
          .map((contact, idx) => `${idx + 1}. ${contact.contactName} (${contact.relationship}) - ${contact.contactPhone}`)
          .join('\n');

        clearSession(sessionId);
        return sendResponse(res, `END Emergency Contacts:\n${contactList}`, 'contactsList');
      } catch (error) {
        console.error('Failed to fetch emergency contacts:', error);
        return sendResponse(res, 'END Could not retrieve contacts. Please try again later.', 'error');
      }
    }

    return sendResponse(res, 'CON Invalid option. Choose 1 or 2', 'emergencyMenu');
  }

  if (session.stage === 'emergencyContactName') {
    if (!input || input.length < 2) {
      return sendResponse(res, 'CON Enter a valid contact name (at least 2 characters)', 'emergencyContactName');
    }

    session.emergencyContact = { contactName: input };
    session.stage = 'emergencyContactPhone';
    return sendResponse(res, 'CON Enter contact phone number', 'emergencyContactPhone');
  }

  if (session.stage === 'emergencyContactPhone') {
    const contactPhone = normalizePhone(input);

    if (!isValidPhone(contactPhone)) {
      return sendResponse(res, 'CON Enter a valid phone number', 'emergencyContactPhone');
    }

    session.emergencyContact.contactPhone = contactPhone;
    session.stage = 'emergencyContactRelationship';
    return sendResponse(
      res,
      'CON Relationship:\n1. Family\n2. Friend\n3. Caregiver\n4. Doctor\n5. Other',
      'emergencyContactRelationship'
    );
  }

  if (session.stage === 'emergencyContactRelationship') {
    const relationshipMap = {
      '1': 'Family',
      '2': 'Friend',
      '3': 'Caregiver',
      '4': 'Doctor',
      '5': 'Other',
    };

    if (!relationshipMap[input]) {
      return sendResponse(
        res,
        'CON Invalid option. Select relationship:\n1. Family\n2. Friend\n3. Caregiver\n4. Doctor\n5. Other',
        'emergencyContactRelationship'
      );
    }

    session.emergencyContact.relationship = relationshipMap[input];
    session.stage = 'emergencyContactPriority';
    return sendResponse(
      res,
      'CON Contact priority:\n1. Primary\n2. Secondary\n3. Tertiary',
      'emergencyContactPriority'
    );
  }

  if (session.stage === 'emergencyContactPriority') {
    if (!['1', '2', '3'].includes(input)) {
      return sendResponse(
        res,
        'CON Invalid option. Select priority:\n1. Primary\n2. Secondary\n3. Tertiary',
        'emergencyContactPriority'
      );
    }

    session.emergencyContact.priority = parseInt(input);
    session.stage = 'emergencyContactConfirm';

    return sendResponse(
      res,
      `CON Confirm emergency contact:\nName: ${session.emergencyContact.contactName}\nPhone: ${session.emergencyContact.contactPhone}\nRelationship: ${session.emergencyContact.relationship}\nPriority: ${session.emergencyContact.priority === 1 ? 'Primary' : session.emergencyContact.priority === 2 ? 'Secondary' : 'Tertiary'}\n1. Confirm\n2. Cancel`,
      'emergencyContactConfirm'
    );
  }

  if (session.stage === 'emergencyContactConfirm') {
    if (input === '1') {
      // Save emergency contact to backend
      const contactData = {
        phoneNumber: session.patient.phoneNumber,
        contactName: session.emergencyContact.contactName,
        contactPhone: session.emergencyContact.contactPhone,
        relationship: session.emergencyContact.relationship,
        priority: session.emergencyContact.priority,
      };

      try {
        const response = await fetch('http://127.0.0.1:8000/api/emergency-contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(contactData),
        });

        if (!response.ok) {
          throw new Error('Backend save failed');
        }

        clearSession(sessionId);
        return sendResponse(
          res,
          `END Emergency contact "${session.emergencyContact.contactName}" saved successfully.`,
          'contactSaved'
        );
      } catch (error) {
        console.error('Failed to save emergency contact:', error);
        clearSession(sessionId);
        return sendResponse(res, 'END Could not save contact. Please try again later.', 'error');
      }
    }

    if (input === '2') {
      clearSession(sessionId);
      return sendResponse(res, 'END Contact not saved', 'cancelled');
    }

    return sendResponse(res, 'CON Please choose 1 to confirm or 2 to cancel', 'emergencyContactConfirm');
  }

  // SOS Alert Flow
  if (session.stage === 'sosPhone') {
    const patientPhone = normalizePhone(input || phoneNumber);

    if (!isValidPhone(patientPhone)) {
      return sendResponse(res, 'CON Enter a valid patient phone number', 'sosPhone');
    }

    const patient = patients.get(patientPhone) || null;

    if (!patient) {
      const backendLookup = await lookupPatientInBackend(patientPhone);

      if (!backendLookup.ok || !backendLookup.patient) {
        return sendResponse(
          res,
          'END Patient not found. Please register the patient first.',
          'notFound'
        );
      }
      patients.set(patientPhone, backendLookup.patient);
      session.patient = backendLookup.patient;
    } else {
      session.patient = patient;
    }

    session.stage = 'sosConfirm';
    return sendResponse(
      res,
      'CON ⚠️ SOS ALERT\nThis will notify your emergency contacts.\n1. Trigger SOS\n2. Cancel',
      'sosConfirm'
    );
  }

  if (session.stage === 'sosConfirm') {
    if (input === '1') {
      session.stage = 'sosLocation';
      return sendResponse(res, 'CON Enter your current location (or 0 to skip)', 'sosLocation');
    }

    if (input === '2') {
      clearSession(sessionId);
      return sendResponse(res, 'END SOS cancelled', 'cancelled');
    }

    return sendResponse(res, 'CON Please choose 1 to trigger or 2 to cancel', 'sosConfirm');
  }

  if (session.stage === 'sosLocation') {
    const location = input === '0' ? 'Location not provided' : input;

    // Trigger SOS alert
    const sosData = {
      phoneNumber: session.patient.phoneNumber,
      triggerType: 'manual',
      location,
      notes: 'Manual SOS triggered via USSD',
    };

    try {
      const response = await fetch('http://127.0.0.1:8000/api/sos/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sosData),
      });

      if (!response.ok) {
        throw new Error('Failed to trigger SOS');
      }

      const result = await response.json();
      console.log('SOS triggered:', result);

      clearSession(sessionId);
      return sendResponse(
        res,
        'END SOS ALERT sent to your emergency contacts. Help is on the way. Stay safe!',
        'sosSent'
      );
    } catch (error) {
      console.error('Failed to trigger SOS:', error);
      clearSession(sessionId);
      return sendResponse(res, 'END Could not send SOS alert. Please call emergency services directly.', 'error');
    }
  }

  return sendResponse(res, 'END Session complete', 'done');
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`USSD app running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  normalizePhone,
  isValidPhone,
  parseBloodPressure,
  getBloodPressureInput,
  app,
  sendToBackend,
  getCurrentInput,
};