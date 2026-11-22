import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = ['http://localhost:3000', process.env.CLIENT_URL].filter(Boolean);

// Middleware
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

// Better Auth JWT verification. Better Auth runs inside the Next.js client app, so
// public keys live at `${AUTH_URL}/api/auth/jwks`. Never trust user-supplied identity.
const authBaseURL = process.env.AUTH_URL || process.env.CLIENT_URL || 'http://localhost:3000';
const jwks = createRemoteJWKSet(new URL(`${authBaseURL}/api/auth/jwks`));

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({
        message: 'Authentication required.',
      });
    }

    const { payload } = await jwtVerify(header.slice(7), jwks, {
      issuer: authBaseURL,
      audience: authBaseURL,
    });

    if (!payload.sub || !payload.email) {
      return res.status(401).json({
        message: 'Invalid access token.',
      });
    }

    req.user = {
      id: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      name: payload.name ? String(payload.name) : '',
    };

    return next();
  } catch {
    return res.status(401).json({
      message: 'Invalid or expired access token.',
    });
  }
}

function ownsEvent(event, user) {
  const ownsById = event.creatorId && String(event.creatorId) === user.id;

  const ownsByEmail =
    typeof event.creatorEmail === 'string' && event.creatorEmail.toLowerCase() === user.email;

  return Boolean(ownsById || ownsByEmail);
}

// Check MongoDB URI
if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is missing from environment variables.');
}

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URI);

let eventsCollection;
let joinsCollection;
let newsletterCollection;

// Connect to MongoDB
async function connectToMongoDB() {
  await client.connect();

  const db = client.db('Togetherly');

  eventsCollection = db.collection('events');
  joinsCollection = db.collection('joinedEvents');
  newsletterCollection = db.collection('newsletter');

  // Prevent duplicate event joins
  await joinsCollection.createIndex({ eventId: 1, userEmail: 1 }, { unique: true });

  // Prevent duplicate newsletter subscriptions
  await newsletterCollection.createIndex({ email: 1 }, { unique: true });

  console.log('You successfully connected to MongoDB!');
}

// Helper functions
const isValidId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function validateEvent(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Invalid event data.';
  }

  const required = [
    'title',
    'description',
    'eventType',
    'imageURL',
    'location',
    'eventDate',
    'creatorEmail',
  ];

  for (const key of required) {
    if (!cleanText(data[key])) {
      return `${key} is required.`;
    }
  }

  // Validate image URL
  try {
    const imageURL = new URL(data.imageURL);

    if (!['http:', 'https:'].includes(imageURL.protocol) || !imageURL.hostname) {
      return 'Please provide a valid image URL.';
    }
  } catch {
    return 'Please provide a valid image URL.';
  }

  // Validate event date
  const date = new Date(data.eventDate);

  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    return 'Event date must be in the future.';
  }

  // Validate creator email
  if (!isValidEmail(cleanText(data.creatorEmail))) {
    return 'A valid creator email is required.';
  }

  return null;
}

// Home route
app.get('/', (req, res) => {
  res.send('Togetherly API is running.');
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Togetherly API',
  });
});

// Get recent events
app.get('/api/events/recent', async (req, res, next) => {
  try {
    const requestedLimit = Math.trunc(Number(req.query.limit) || 6);

    const limit = Math.min(Math.max(requestedLimit, 1), 20);

    const events = await eventsCollection
      .find({
        eventDate: { $gt: new Date().toISOString() },
      })
      .sort({ eventDate: 1 })
      .limit(limit)
      .toArray();

    res.json(events);
  } catch (error) {
    next(error);
  }
});

// Get all events
app.get('/api/events', async (req, res, next) => {
  try {
    const filter = {
      eventDate: { $gt: new Date().toISOString() },
    };

    if (req.query.type && req.query.type !== 'All') {
      filter.eventType = req.query.type;
    }

    const events = await eventsCollection.find(filter).sort({ eventDate: 1 }).toArray();

    res.json(events);
  } catch (error) {
    next(error);
  }
});

// Get single event
app.get('/api/events/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
      });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    res.json(event);
  } catch (error) {
    next(error);
  }
});

// Create event
app.post('/api/events', authenticate, async (req, res, next) => {
  try {
    const data = {
      ...req.body,
      creatorEmail: req.user.email,
    };

    const error = validateEvent(data);

    if (error) {
      return res.status(400).json({
        message: error,
      });
    }

    const event = {
      title: cleanText(data.title),
      description: cleanText(data.description),
      eventType: cleanText(data.eventType),
      imageURL: cleanText(data.imageURL),
      location: cleanText(data.location),
      eventDate: new Date(data.eventDate).toISOString(),
      creatorId: req.user.id,
      creatorEmail: req.user.email,
      creatorName: req.user.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await eventsCollection.insertOne(event);

    res.status(201).json({
      message: 'Event created successfully.',
      insertedId: result.insertedId,
    });
  } catch (error) {
    next(error);
  }
});

// Update event
app.patch('/api/events/:id', authenticate, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
      });
    }

    const existing = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!existing) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    if (!ownsEvent(existing, req.user)) {
      return res.status(403).json({
        message: 'You can only update your own events.',
      });
    }

    // Owner identity is never taken from the request body.
    const data = {
      ...existing,
      ...req.body,
      creatorEmail: existing.creatorEmail,
    };

    const error = validateEvent(data);

    if (error) {
      return res.status(400).json({
        message: error,
      });
    }

    const allowed = ['title', 'description', 'eventType', 'imageURL', 'location', 'eventDate'];

    const update = Object.fromEntries(
      allowed
        .filter((key) => req.body?.[key] !== undefined)
        .map((key) => [
          key,
          key === 'eventDate' ? new Date(req.body[key]).toISOString() : cleanText(req.body[key]),
        ])
    );

    update.updatedAt = new Date().toISOString();

    const result = await eventsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: update }
    );

    res.json({
      message: 'Event updated successfully.',
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    next(error);
    api;
  }
});
// Delete event
app.delete('/api/events/:id', authenticate, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
      });
    }

    const existing = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!existing) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    if (!ownsEvent(existing, req.user)) {
      return res.status(403).json({
        message: 'You can only delete your own events.',
      });
    }

    const result = await eventsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    if (!result.deletedCount) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    // Delete related joins
    await joinsCollection.deleteMany({
      eventId: req.params.id,
    });

    res.json({
      message: 'Event deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
});
// Delete event
app.delete('/api/events/:id', authenticate, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
      });
    }

    const existing = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!existing) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    if (!ownsEvent(existing, req.user)) {
      return res.status(403).json({
        message: 'You can only delete your own events.',
      });
    }

    const result = await eventsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    if (!result.deletedCount) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    // Delete related joins
    await joinsCollection.deleteMany({
      eventId: req.params.id,
    });

    res.json({
      message: 'Event deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
});
// Join event
app.post('/api/events/:id/join', authenticate, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
      });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      return res.status(404).json({
        message: 'Event not found.',
      });
    }

    if (new Date(event.eventDate) <= new Date()) {
      return res.status(400).json({
        message: 'This event has already passed.',
      });
    }

    const userEmail = req.user.email;
    const userName = req.user.name;

    try {
      await joinsCollection.insertOne({
        eventId: req.params.id,
        eventTitle: event.title,
        eventDate: event.eventDate,
        eventImage: event.imageURL,
        location: event.location,
        userEmail,
        userName,
        joinedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          message: 'You have already joined this event.',
        });
      }

      throw error;
    }

    res.status(201).json({
      message: 'You joined this event successfully.',
    });
  } catch (error) {
    next(error);
  }
});
// Get joined events
app.get('/api/joins', authenticate, async (req, res, next) => {
  try {
    const joins = await joinsCollection
      .find({ userEmail: req.user.email })
      .sort({ eventDate: 1 })
      .toArray();

    res.json(joins);
  } catch (error) {
    next(error);
  }
});

// Get the signed-in user's own events
app.get('/api/me/events', authenticate, async (req, res, next) => {
  try {
    const events = await eventsCollection
      .find({
        $or: [{ creatorId: req.user.id }, { creatorEmail: req.user.email }],
      })
      .sort({ eventDate: 1 })
      .toArray();

    res.json(events);
  } catch (error) {
    next(error);
  }
});

// Get events the signed-in user joined
app.get('/api/me/joined', authenticate, async (req, res, next) => {
  try {
    const joins = await joinsCollection.find({ userEmail: req.user.email }).toArray();

    const eventIds = joins
      .map((join) => join.eventId)
      .filter((eventId) => typeof eventId === 'string' && isValidId(eventId))
      .map((eventId) => new ObjectId(eventId));

    if (!eventIds.length) {
      return res.json([]);
    }

    const events = await eventsCollection
      .find({ _id: { $in: eventIds } })
      .sort({ eventDate: 1 })
      .toArray();

    res.json(events);
  } catch (error) {
    next(error);
  }
});

// Newsletter subscription
app.post('/api/newsletter', async (req, res, next) => {
  try {
    const email = cleanText(req.body?.email).toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({
        message: 'Please enter a valid email address.',
      });
    }

    try {
      await newsletterCollection.insertOne({
        email,
        subscribedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          message: 'This email is already subscribed.',
        });
      }

      throw error;
    }

    res.status(201).json({
      message: 'Thanks for subscribing!',
    });
  } catch (error) {
    next(error);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    message: 'Route not found.',
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error(error);

  const statusCode = error.status || error.statusCode || 500;

  res.status(statusCode).json({
    message: statusCode >= 500 ? 'Something went wrong on the server.' : error.message,
  });
});

// Start server
connectToMongoDB()
  .then(() => {
    app.listen(port, () => {
      console.log(`Togetherly API listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  });
