/**
 * Database Abstraction Layer for Sickly Ignite
 * Supports both Redis (Vercel/Production) and JSON files (Local Development)
 */

const fs = require('fs').promises;
const path = require('path');

// Try to import Redis, fallback gracefully if not available
let Redis;
let redis = null;

try {
  const { Redis: RedisClient } = require('@upstash/redis');
  Redis = RedisClient;

  // Initialize Redis if environment variables are set
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('✓ Redis initialized (Production mode)');
  } else {
    console.log('⚠ Redis credentials not found, using JSON file storage (Development mode)');
  }
} catch (error) {
  console.log('⚠ @upstash/redis not installed, using JSON file storage (Development mode)');
}

const DATA_DIR = path.join(process.cwd(), 'data');
const FILES = {
  patients: path.join(DATA_DIR, 'patients.json'),
  readings: path.join(DATA_DIR, 'readings.json'),
  medications: path.join(DATA_DIR, 'medications.json'),
  adherence: path.join(DATA_DIR, 'adherence.json'),
  emergencyContacts: path.join(DATA_DIR, 'emergency-contacts.json'),
  sosEvents: path.join(DATA_DIR, 'sos-events.json'),
  counters: path.join(DATA_DIR, 'counters.json'),
};

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }
}

// ========== REDIS OPERATIONS ==========

async function redisGet(key) {
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    return data;
  } catch (error) {
    console.error(`Redis GET error for ${key}:`, error.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!redis) return false;
  try {
    await redis.set(key, value);
    return true;
  } catch (error) {
    console.error(`Redis SET error for ${key}:`, error.message);
    return false;
  }
}

// ========== JSON FILE OPERATIONS ==========

async function readJSONFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    console.error(`Error reading ${filePath}:`, error.message);
    return null;
  }
}

async function writeJSONFile(filePath, data) {
  try {
    await ensureDataDir();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error.message);
    return false;
  }
}

// ========== DATABASE OPERATIONS ==========

/**
 * Load data from storage (Redis or JSON)
 * @param {string} key - Data key (patients, readings, etc.)
 * @returns {Promise<any>} - The data or null if not found
 */
async function loadData(key) {
  // Try Redis first
  if (redis) {
    const data = await redisGet(`sickly:${key}`);
    if (data !== null) {
      return data;
    }
  }

  // Fallback to JSON file
  const filePath = FILES[key];
  if (!filePath) {
    console.error(`Unknown data key: ${key}`);
    return null;
  }

  return await readJSONFile(filePath);
}

/**
 * Save data to storage (Redis and JSON)
 * @param {string} key - Data key (patients, readings, etc.)
 * @param {any} data - The data to save
 * @returns {Promise<boolean>} - Success status
 */
async function saveData(key, data) {
  const filePath = FILES[key];
  if (!filePath) {
    console.error(`Unknown data key: ${key}`);
    return false;
  }

  // Save to Redis if available
  if (redis) {
    await redisSet(`sickly:${key}`, data);
  }

  // Always save to JSON file as backup
  return await writeJSONFile(filePath, data);
}

/**
 * Delete data from storage
 * @param {string} key - Data key
 * @returns {Promise<boolean>} - Success status
 */
async function deleteData(key) {
  if (redis) {
    try {
      await redis.del(`sickly:${key}`);
    } catch (error) {
      console.error(`Redis DEL error for ${key}:`, error.message);
    }
  }

  const filePath = FILES[key];
  if (filePath) {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error deleting ${filePath}:`, error.message);
      }
      return false;
    }
  }

  return false;
}

/**
 * Load all data at startup
 * @returns {Promise<Object>} - All data collections
 */
async function loadAllData() {
  console.log('Loading data from storage...');

  const [patients, readings, medications, adherence, emergencyContacts, sosEvents, counters] = await Promise.all([
    loadData('patients'),
    loadData('readings'),
    loadData('medications'),
    loadData('adherence'),
    loadData('emergencyContacts'),
    loadData('sosEvents'),
    loadData('counters'),
  ]);

  return {
    patients: patients || [],
    readings: readings || [],
    medications: medications || [],
    adherence: adherence || [],
    emergencyContacts: emergencyContacts || [],
    sosEvents: sosEvents || [],
    counters: counters || { patientIdCounter: 1, medicationIdCounter: 1, sosIdCounter: 1, adherenceIdCounter: 1 },
  };
}

/**
 * Save all data
 * @param {Object} data - All data collections
 * @returns {Promise<void>}
 */
async function saveAllData(data) {
  await Promise.all([
    saveData('patients', data.patients),
    saveData('readings', data.readings),
    saveData('medications', data.medications),
    saveData('adherence', data.adherence),
    saveData('emergencyContacts', data.emergencyContacts),
    saveData('sosEvents', data.sosEvents),
    saveData('counters', data.counters),
  ]);
}

module.exports = {
  loadData,
  saveData,
  deleteData,
  loadAllData,
  saveAllData,
  isUsingRedis: () => redis !== null,
};
