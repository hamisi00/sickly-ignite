/**
 * Vercel Cron Job for Medication Reminders
 * Runs every minute to check and send medication reminders
 *
 * This is triggered by Vercel Cron based on vercel.json configuration
 */

require('dotenv').config();
const { loadData } = require('../../lib/db');
const AfricasTalking = require('africastalking');

// Initialize Africa's Talking
const atCredentials = {
  apiKey: process.env.AT_API_KEY || 'YOUR_API_KEY_HERE',
  username: process.env.AT_USERNAME || 'sandbox',
};
const africastalking = AfricasTalking(atCredentials);
const sms = africastalking.SMS;

// Send SMS reminder
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

// Main cron handler
module.exports = async (req, res) => {
  console.log('--- Medication Reminder Cron Job Triggered ---');
  console.log('Time:', new Date().toISOString());

  // Verify this is a cron request (security check)
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    console.log('Unauthorized cron request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    console.log(`Current time: ${currentTime}`);

    // Load medications and adherence data
    const [medicationsData, adherenceData] = await Promise.all([
      loadData('medications'),
      loadData('adherence')
    ]);

    const medications = medicationsData || [];
    const adherenceLog = adherenceData || [];

    // Filter active medications
    const activeMedications = medications.filter(med => med.active);
    console.log(`Found ${activeMedications.length} active medications`);

    let remindersSent = 0;

    // Check each medication
    for (const medication of activeMedications) {
      const { phoneNumber, times, name, dosage, id } = medication;

      if (!times || !Array.isArray(times)) continue;

      // Check if current time matches any scheduled time
      if (times.includes(currentTime)) {
        console.log(`Time match for ${phoneNumber}: ${name} at ${currentTime}`);

        // Check if reminder already sent today at this time
        const today = now.toDateString();
        const alreadySent = adherenceLog.some(
          log =>
            log.medicationId === id &&
            log.scheduledTime === currentTime &&
            new Date(log.timestamp).toDateString() === today
        );

        if (alreadySent) {
          console.log(`Reminder already sent for ${name} at ${currentTime}`);
          continue;
        }

        // Send reminder
        await sendSMSReminder(phoneNumber, name, dosage, currentTime);
        remindersSent++;

        // Note: Adherence log will be created when SMS is sent
        // The backend SMS handler will create the log entry
      }
    }

    console.log(`Total reminders sent: ${remindersSent}`);
    console.log('--- Cron job complete ---\n');

    res.status(200).json({
      success: true,
      remindersSent,
      timestamp: now.toISOString()
    });
  } catch (error) {
    console.error('Cron job error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
