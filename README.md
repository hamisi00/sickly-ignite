# Sickly Ignite - Diabetes Patient Monitoring System

A USSD-based diabetes monitoring system with medication reminders and SOS alerts for Kenya, built for the IEEE Tech Ignite Hackathon.

## Features

### Phase 1: Core Monitoring
- ✅ Patient registration via USSD
- ✅ Glucose and blood pressure readings
- ✅ Admin dashboard with metrics
- ✅ JSON file-based data persistence

### Phase 2: Medication Reminders
- ✅ Medication management via USSD
- ✅ Automated SMS reminders at scheduled times
- ✅ SMS-based adherence confirmation
- ✅ Adherence tracking dashboard

### Phase 3: SOS System
- ✅ Emergency contacts management
- ✅ Manual SOS trigger
- ✅ Auto-SOS for dangerous glucose levels
- ✅ SMS alerts to emergency contacts

### Phase 4: Enhanced Backend & Analytics
- ✅ Chart.js visualizations (glucose trends, medication adherence)
- ✅ Test data seeding via dashboard button
- ✅ Data export functionality (JSON)
- ✅ Clear all data functionality
- ✅ Toast notifications for user feedback
- ✅ Persistent JSON file storage

## System Architecture

```
┌─────────────────┐
│  Patient Phone  │
│   *384*39981#   │
│   SMS Replies   │
└────────┬────────┘
         │
    ┌────▼─────┐
    │  ngrok   │ (Single Tunnel - Port 8000)
    └────┬─────┘
         │
┌────────▼───────────────────────────────────────────────┐
│  backend.js - UNIFIED BACKEND SERVER (Port 8000)       │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  Dashboard   │  │ Cron Reminder│  │ SMS Handler  │ │
│  │  & API       │  │  Scheduler   │  │  /sms        │ │
│  │  Endpoints   │  │ (Every min)  │  │  Endpoint    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                         │
│  Features:                                              │
│  - JSON data persistence      - SOS alerts (via        │
│  - Admin dashboard            sos-alerts.js module)    │
│  - Analytics & charts         - Medication reminders   │
│  - Test data seeding          - SMS confirmations      │
└─────────────────────────────────────────────────────────┘

Optional USSD App (for testing):
┌────────────────────┐
│   ignite.js        │ (Port 3000)
│ - Patient flows    │
│ - USSD interface   │
└────────────────────┘
```

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Africa's Talking

1. Sign up at https://africastalking.com/
2. Go to sandbox: https://account.africastalking.com/apps/sandbox
3. Get your API Key from Settings → API Key
4. Create `.env` file:

```bash
cp .env.example .env
```

5. Edit `.env` and add your credentials:

```
AT_USERNAME=sandbox
AT_API_KEY=your_actual_api_key_here
```

### 3. Setup USSD Channel

1. In Africa's Talking sandbox, go to USSD → Create Channel
2. Use USSD code: `*384*39981#` (or your assigned code)
3. Set callback URL: `https://your-ngrok-url.ngrok-free.dev/ussd`

### 4. Setup SMS Callback (for adherence confirmations)

1. Go to SMS → Callback URLs
2. Set delivery reports URL: `https://your-ngrok-url.ngrok-free.dev/sms`

**Note**: Both USSD and SMS now use the same ngrok tunnel on port 8000

### 5. Start Services

Open 2 terminal windows:

**Terminal 1 - Unified Backend Server:**
```bash
npm run server
# or: node backend.js
```

This single server includes:
- ✓ Dashboard & API endpoints (http://localhost:8000)
- ✓ Medication reminder scheduler (runs every minute)
- ✓ SMS webhook handler (http://localhost:8000/sms)
- ✓ SOS alert system
- ✓ JSON data persistence

**Terminal 2 - ngrok Tunnel:**
```bash
ngrok http 8000
```

Copy the HTTPS URL and update Africa's Talking callbacks:
- **USSD Callback**: `https://your-ngrok-url.ngrok-free.dev/ussd`
- **SMS Callback**: `https://your-ngrok-url.ngrok-free.dev/sms`

**Optional - USSD App (if testing USSD separately):**
```bash
npm start
# Runs on port 3000
```

**Note**: The USSD app (`ignite.js`) is separate and still needs to run if you want to test USSD flows. Use `ngrok http 3000` for USSD testing.

## Usage

### Patient Registration
1. Dial `*384*39981#`
2. Select option 1: Register patient
3. Enter phone number, age, diabetes type, region, county
4. Confirm details

### Submit Health Reading
1. Dial `*384*39981#`
2. Select option 2: Enter readings
3. Enter phone number
4. Enter glucose reading (mg/dL)
5. Enter blood pressure (e.g., 120/80) or 0 to skip

### Add Medication
1. Dial `*384*39981#`
2. Select option 3: Manage medications
3. Select option 1: Add new medication
4. Enter medication name (e.g., Metformin)
5. Enter dosage (e.g., 500mg)
6. Select frequency (once/twice/thrice/custom daily)
7. Enter times in 24hr format (e.g., 08:00, 20:00)
8. Confirm

### Check Medication Reminders
1. Dial `*384*39981#`
2. Select option 4: Check medication reminders
3. View today's medication schedule

### Confirm Medication Intake
When you receive an SMS reminder:
```
Medication Reminder: It's time to take your Metformin (500mg). Reply YES to confirm you've taken it.
```

Reply with: `YES`, `Y`, `TAKEN`, `OK`, or `DONE`

## Admin Dashboard

Access at http://localhost:8000

### Pages:
- **Dashboard**: Overview metrics, analytics charts, utility buttons
  - Glucose readings trend chart (last 10 readings)
  - Medication adherence pie chart
  - Seed test data button
  - Clear all data button
  - Refresh dashboard button
  - Export data button (JSON download)
- **Patients**: Full patient list with search
- **Readings**: All health readings with filtering
- **Medications**: Active medication schedules
- **Adherence**: Medication compliance tracking

### Dashboard Features:
- **Analytics**: Chart.js visualizations showing glucose trends and adherence rates
- **Toast Notifications**: Real-time feedback for all actions
- **Data Management**: Seed, clear, export, and refresh data
- **JSON Persistence**: All data automatically saved to `/data` directory

## API Endpoints

### Patients
- `GET /api/patients` - Get all patients
- `GET /api/patients/:phone` - Get patient by phone

### Readings
- `GET /api/readings` - Get all readings
- `GET /api/readings/:phone` - Get readings for patient

### Medications
- `GET /api/medications` - Get all medications
- `GET /api/medications/:phone` - Get patient's medications
- `POST /api/medications` - Add medication
- `PUT /api/medications/:id` - Update medication
- `DELETE /api/medications/:id` - Deactivate medication

### Adherence
- `GET /api/adherence` - Get all adherence logs
- `GET /api/adherence/:phone` - Get patient adherence
- `GET /api/adherence/stats/:phone` - Get compliance stats
- `POST /api/adherence/confirm` - Confirm medication taken

### Emergency Contacts (Phase 3)
- `GET /api/emergency-contacts/:phone` - Get contacts
- `POST /api/emergency-contacts` - Add contact
- `DELETE /api/emergency-contacts` - Remove contact

### SOS Events
- `GET /api/sos/events` - Get all SOS events
- `GET /api/sos/events/:phone` - Get patient SOS events
- `POST /api/sos/trigger` - Trigger SOS alert (sends SMS to emergency contacts)
- `PUT /api/sos/:id/resolve` - Resolve SOS event

### Data Management
- `POST /api/seed` - Seed test data (3 patients, 30 readings, medications, etc.)
- `POST /api/reset` - Clear all data and reset counters

## Medication Reminder System

### How it works:
1. **Scheduler** (`reminder-scheduler.js`) runs every minute
2. Checks all active medications for matching times
3. When time matches:
   - Creates adherence log entry with status "pending"
   - Sends SMS reminder to patient
4. **SMS Handler** (`sms-handler.js`) receives patient responses
5. When patient replies "YES":
   - Updates adherence log to "taken"
   - Records timestamp

### Adherence Metrics:
- **Doses Taken**: Confirmed via SMS or USSD
- **Doses Missed**: Pending doses not confirmed within timeframe
- **Adherence Rate**: (Taken / Total) × 100%

## Testing

### Test Medication Reminders:
1. Add a medication with a time 2 minutes from now
2. Wait for the reminder scheduler to send SMS
3. Reply "YES" to the SMS
4. Check adherence dashboard to see confirmation

### Test USSD Flows:
Use Africa's Talking USSD simulator:
https://simulator.africastalking.com:1517/

## Project Structure

```
sickly-ignite/
├── ignite.js              # USSD application (optional, port 3000)
├── backend.js             # ⭐ UNIFIED BACKEND SERVER (port 8000)
│                          #   - Dashboard & API
│                          #   - Medication reminder scheduler
│                          #   - SMS webhook handler
│                          #   - SOS alerts
│                          #   - JSON data persistence
├── mock-backend.js        # Original backend (backup)
├── reminder-scheduler.js  # Standalone reminder service (backup)
├── sms-handler.js         # Standalone SMS handler (backup)
├── sos-alerts.js          # SOS SMS alert module
├── data/                  # JSON data storage directory
│   ├── patients.json
│   ├── readings.json
│   ├── medications.json
│   ├── adherence.json
│   ├── emergency-contacts.json
│   ├── sos-events.json
│   └── counters.json
├── package.json           # Dependencies & scripts
├── .env.example           # Environment variables template
└── README.md              # This file
```

## Tech Stack

- **Backend**: Node.js + Express.js v5.2.1
- **USSD**: Africa's Talking USSD Gateway
- **SMS**: Africa's Talking SMS API
- **Scheduling**: node-cron
- **Tunneling**: ngrok
- **Storage**: JSON files (persistent) + In-memory (Map/Array)
- **Analytics**: Chart.js v4.x
- **UI**: Vanilla JavaScript with modern CSS gradients

## Environment

- **Platform**: Linux (Ubuntu/Debian)
- **Node Version**: v14+ recommended
- **Ports Used**:
  - 3000: USSD App
  - 3001: SMS Handler
  - 8000: Backend Dashboard

## Hackathon Context

Built for IEEE Tech Ignite Hackathon (Sept 2-4, 2026)
- **Focus**: Diabetes management in Kenya
- **Target Users**: Diabetes patients with basic phones
- **Key Innovation**: No internet required (USSD + SMS)

## License

ISC

## Contributors

- Hamisi (Developer)
- Claude Code (AI Assistant)
