const AfricasTalking = require('africastalking');

// Initialize Africa's Talking
const credentials = {
  apiKey: process.env.AT_API_KEY || 'YOUR_API_KEY_HERE',
  username: process.env.AT_USERNAME || 'sandbox',
};

const africastalking = AfricasTalking(credentials);
const sms = africastalking.SMS;

const BACKEND_URL = 'http://127.0.0.1:8000';

/**
 * Fetch emergency contacts for a patient
 * @param {string} phoneNumber - Patient's phone number
 * @returns {Promise<Array>} - Array of emergency contacts
 */
async function fetchEmergencyContacts(phoneNumber) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/emergency-contacts/${phoneNumber}`);
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }
    const contacts = await response.json();
    return contacts || [];
  } catch (error) {
    console.error('Failed to fetch emergency contacts:', error.message);
    return [];
  }
}

/**
 * Send SOS SMS alert to an emergency contact
 * @param {string} contactPhone - Emergency contact's phone number
 * @param {string} patientPhone - Patient's phone number
 * @param {object} sosEvent - SOS event details
 * @returns {Promise<object|null>} - SMS send result
 */
async function sendSOSAlert(contactPhone, patientPhone, sosEvent) {
  const triggerReason = sosEvent.triggerType === 'auto'
    ? `CRITICAL glucose level: ${sosEvent.glucoseReading} mg/dL`
    : 'Manual SOS activated';

  const location = sosEvent.location || 'Location not provided';

  const message = `🚨 EMERGENCY ALERT: Patient ${patientPhone} needs immediate assistance!\n\nReason: ${triggerReason}\nLocation: ${location}\n\nPlease contact them immediately or call emergency services.`;

  console.log(`Sending SOS alert to ${contactPhone}`);
  console.log(`Message: ${message}`);

  try {
    const result = await sms.send({
      to: [contactPhone],
      message,
      from: process.env.AT_SENDER_ID || null,
    });

    console.log('SOS SMS sent successfully:', result);
    return result;
  } catch (error) {
    console.error('Failed to send SOS SMS:', error.message);
    return null;
  }
}

/**
 * Send SOS alerts to all emergency contacts
 * @param {string} phoneNumber - Patient's phone number
 * @param {object} sosEvent - SOS event details
 * @returns {Promise<object>} - Alert sending results
 */
async function sendSOSAlerts(phoneNumber, sosEvent) {
  console.log('\n--- SENDING SOS ALERTS ---');
  console.log(`Patient: ${phoneNumber}`);
  console.log(`Trigger Type: ${sosEvent.triggerType}`);

  // Fetch emergency contacts
  const contacts = await fetchEmergencyContacts(phoneNumber);

  if (contacts.length === 0) {
    console.error('No emergency contacts found for patient');
    return {
      success: false,
      message: 'No emergency contacts configured',
      alertsSent: 0,
      alertsFailed: 0,
    };
  }

  console.log(`Found ${contacts.length} emergency contact(s)`);

  // Sort contacts by priority (1 = primary, 2 = secondary, 3 = tertiary)
  const sortedContacts = contacts.sort((a, b) => a.priority - b.priority);

  let alertsSent = 0;
  let alertsFailed = 0;

  // Send alerts to all contacts
  for (const contact of sortedContacts) {
    console.log(`\nAlerting: ${contact.contactName} (${contact.relationship}) - Priority ${contact.priority}`);

    const result = await sendSOSAlert(contact.contactPhone, phoneNumber, sosEvent);

    if (result) {
      alertsSent++;
      console.log(`✓ Alert sent to ${contact.contactName}`);
    } else {
      alertsFailed++;
      console.error(`✗ Failed to alert ${contact.contactName}`);
    }
  }

  console.log(`\nSOS Alerts Summary: ${alertsSent} sent, ${alertsFailed} failed`);
  console.log('--- SOS ALERT PROCESS COMPLETE ---\n');

  return {
    success: alertsSent > 0,
    message: `SOS alerts sent to ${alertsSent} contact(s)`,
    alertsSent,
    alertsFailed,
    contacts: sortedContacts.length,
  };
}

/**
 * Check glucose reading and trigger auto-SOS if dangerous
 * @param {string} phoneNumber - Patient's phone number
 * @param {number} glucoseReading - Glucose reading in mg/dL
 * @param {string} location - Patient's location (optional)
 * @returns {Promise<object|null>} - SOS trigger result if dangerous level detected
 */
async function checkAndTriggerAutoSOS(phoneNumber, glucoseReading, location = null) {
  const CRITICAL_LOW = 70;   // mg/dL
  const CRITICAL_HIGH = 300; // mg/dL

  console.log(`\nChecking glucose level: ${glucoseReading} mg/dL for ${phoneNumber}`);

  if (glucoseReading < CRITICAL_LOW || glucoseReading > CRITICAL_HIGH) {
    const severity = glucoseReading < CRITICAL_LOW ? 'CRITICALLY LOW' : 'CRITICALLY HIGH';
    console.warn(`⚠️ ${severity} GLUCOSE DETECTED: ${glucoseReading} mg/dL`);
    console.log('Triggering auto-SOS...');

    // Trigger SOS via backend API
    const sosData = {
      phoneNumber,
      triggerType: 'auto',
      glucoseReading,
      location: location || 'Auto-detected from health reading',
      notes: `Auto-triggered: Glucose ${severity} (${glucoseReading} mg/dL)`,
    };

    try {
      const response = await fetch(`${BACKEND_URL}/api/sos/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sosData),
      });

      if (!response.ok) {
        throw new Error(`Failed to trigger auto-SOS: ${response.status}`);
      }

      const result = await response.json();
      console.log('Auto-SOS triggered successfully:', result);

      // Send alerts to emergency contacts
      const alertResult = await sendSOSAlerts(phoneNumber, sosData);

      return {
        sosTrigger: result,
        alerts: alertResult,
      };
    } catch (error) {
      console.error('Failed to trigger auto-SOS:', error.message);
      return null;
    }
  } else {
    console.log('✓ Glucose level normal, no SOS needed');
    return null;
  }
}

// Export functions
module.exports = {
  sendSOSAlerts,
  sendSOSAlert,
  fetchEmergencyContacts,
  checkAndTriggerAutoSOS,
};

// Command-line testing
if (require.main === module) {
  console.log('🚨 SOS Alert System - Test Mode');
  console.log('========================================\n');

  const testPhoneNumber = process.argv[2] || '+254712345678';
  const testGlucose = parseInt(process.argv[3]) || 350;

  console.log(`Testing with:`);
  console.log(`  Phone: ${testPhoneNumber}`);
  console.log(`  Glucose: ${testGlucose} mg/dL\n`);

  checkAndTriggerAutoSOS(testPhoneNumber, testGlucose, 'Test Location')
    .then(result => {
      if (result) {
        console.log('\n✅ Auto-SOS test completed');
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('\n✓ No SOS triggered (glucose level normal)');
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Auto-SOS test failed:', error.message);
      process.exit(1);
    });
}
