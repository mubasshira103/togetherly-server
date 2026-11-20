
import express from 'express';
import 'dotenv/config';
import cors from 'cors';
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
app.post('/api/events', async (req, res, next) => {
  try {
    const data = req.body;

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
      creatorEmail: cleanText(data.creatorEmail).toLowerCase(),
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
app.patch('/api/events/:id', async (req, res, next) => {
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

    const data = {
      ...existing,
      ...req.body,
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
  }
});

// Delete event
app.delete('/api/events/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid event ID.',
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
app.post('/api/events/:id/join', async (req, res, next) => {
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

    const userEmail = cleanText(req.body?.userEmail).toLowerCase();
    const userName = cleanText(req.body?.userName);

    if (!isValidEmail(userEmail)) {
      return res.status(400).json({
        message: 'A valid user email is required.',
      });
    }

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
app.get('/api/joins', async (req, res, next) => {
  try {
    const email = cleanText(req.query.email).toLowerCase();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: 'A valid email query is required.',
      });
    }

    const joins = await joinsCollection.find({ userEmail: email }).sort({ eventDate: 1 }).toArray();

    res.json(joins);
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
