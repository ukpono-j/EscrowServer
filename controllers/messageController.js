const Message = require('../modules/Message');

exports.getMessages = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    const messages = await Message.find({ chatroomId }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

exports.addMessage = async (req, res) => {
  try {
    const { chatroomId, userId, userFirstName, message } = req.body;
    const newMessage = new Message({ chatroomId, userId, userFirstName, message });
    await newMessage.save();
    res.status(201).json(newMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add message' });
  }
};
