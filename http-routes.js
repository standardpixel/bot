const express = require('express');
const { processMessage } = require('./message-processor');
const { getUserModel } = require('./model-config');

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main chat endpoint
router.post('/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        response: null,
        conversationId: null,
        error: 'Invalid request: message is required and must be a string'
      });
    }

    // Use default model for HTTP requests (no user-specific model)
    // The HTTP user can be configured via environment variable or use default
    const httpUserId = process.env.HTTP_USER_ID || 'http-user';
    const userModel = getUserModel(httpUserId);

    console.log(`[HTTP] Processing message from iOS app: "${message.slice(0, 50)}..."`);

    const result = await processMessage({
      messageText: message,
      conversationHistory: conversationHistory || [],
      userId: httpUserId,
      userModel,
      statusCallback: null, // No status updates for HTTP
    });

    if (result.success) {
      res.json({
        response: result.response,
        conversationId: null, // Not using server-side session storage for now
        error: null
      });
    } else {
      res.status(500).json({
        response: null,
        conversationId: null,
        error: result.error
      });
    }
  } catch (err) {
    console.error('[HTTP] Error processing message:', err.message);
    res.status(500).json({
      response: null,
      conversationId: null,
      error: err.message
    });
  }
});

module.exports = router;
