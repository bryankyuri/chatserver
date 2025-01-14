// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://groupchatroom.vercel.app"],
    methods: ["GET", "POST"],
  },
});

// In-memory data storage
const groups = new Map(); // Store group information
const rooms = new Map(); // Store room information
const sessions = new Map();
const activeUsers = new Map();
const userSockets = new Map();
const roomMembers = new Map();

const isGroupAdmin = (groupId, userId) => {
  const group = groups.get(groupId);
  return group && group.adminId === userId;
};

// Helper function to get active users in a room
const getRoomActiveUsers = (roomId) => {
  const room = io.sockets.adapter.rooms.get(roomId);
  return room ? room.size : 0;
};

// Helper function to update room information
const updateRoomInfo = (roomId) => {
  const room = rooms.get(roomId);
  if (room) {
    const roomInfo = {
      name: room.name,
      activeUsers: getRoomActiveUsers(roomId),
    };
    io.to(roomId).emit("room:info", roomInfo);

    // Send updated user list
    const users = getRoomUsers(roomId);
    io.to(roomId).emit("room:users", users);
  }
};

const getRoomUsers = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return [];

  const users = [];
  const roomSockets = io.sockets.adapter.rooms.get(roomId);

  if (roomSockets) {
    for (const socketId of roomSockets) {
      const user = activeUsers.get(socketId);
      if (user && !users.some((u) => u.id === user.id)) {
        users.push(user);
      }
    }
  }

  return users;
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle group creation
  socket.on("group:create", ({ name, maxUsers, creator }) => {
    try {
      if (!name || !creator) {
        socket.emit("group:error", "Invalid group data");
        return;
      }

      const groupId = `group_${Date.now()}`;
      const newGroup = {
        id: groupId,
        name,
        maxUsers: maxUsers || 100, // Default max users
        isPublic: true, // Make group public by default
        adminId: creator.id,
        members: [creator.id], // Start with creator as member
        createdAt: new Date().toISOString(),
      };

      groups.set(groupId, newGroup);
      socket.join(groupId);
      socket.emit("group:created", { groupId, group: newGroup });
      io.emit("groups:update", Array.from(groups.values()));
    } catch (error) {
      console.error("Error creating group:", error);
      socket.emit("group:error", "Failed to create group");
    }
  });

  socket.on("user:login", (userData) => {
    try {
      // Add any validation here if needed
      const user = {
        ...userData,
        socketId: socket.id,
      };

      // Store user in active users
      activeUsers.set(socket.id, user);
      sessions.set(socket.id, user);

      // Send success response
      socket.emit("login:success", user);
    } catch (error) {
      console.error("Login error:", error);
      socket.emit("login:error", "Failed to login. Please try again.");
    }
  });

  // Handle user connection
  socket.on("user:connect", (user) => {
    // Store user's socket ID
    if (!userSockets.has(user.id)) {
      userSockets.set(user.id, new Set());
    }
    userSockets.get(user.id).add(socket.id);

    activeUsers.set(socket.id, user);
    sessions.set(socket.id, user);
    socket.emit("rooms:update", Array.from(rooms.values()));
  });

  // Handle room creation within a group
  socket.on("room:create", ({ groupId, name, description, creator }) => {
    try {
      if (!name || !creator) {
        socket.emit("room:error", "Invalid room data");
        return;
      }

      const group = groups.get(groupId);
      if (!group) {
        socket.emit("room:error", "Group not found");
        return;
      }

      const roomId = `room_${Date.now()}`;
      const newRoom = {
        id: roomId,
        groupId,
        name,
        description,
        isPublic: true, // Default to public
        creator,
        members: [...group.members], // Copy group members
        activeMembers: new Set(),
        messages: [],
      };

      rooms.set(roomId, newRoom);

      // Update group's rooms list
      if (!group.rooms) group.rooms = [];
      group.rooms.push(roomId);

      // Notify all group members about the new room
      io.to(groupId).emit("rooms:update", {
        groupId,
        rooms: Array.from(rooms.values())
          .filter((room) => room.groupId === groupId)
          .map((room) => ({
            ...room,
            memberCount: room.members.length,
            activeMembers: room.activeMembers.size,
          })),
      });

      socket.emit("room:created", { roomId });
    } catch (error) {
      console.error("Error creating room:", error);
      socket.emit("room:error", "Failed to create room");
    }
  });

  socket.on("group:join-request", ({ groupId, user }) => {
    const group = groups.get(groupId);
    if (!group) return;

    if (group.members.length >= group.maxUsers) {
      socket.emit("group:error", "Group has reached maximum capacity");
      return;
    }

    if (group.isPublic) {
      group.members.push(user.id);
      socket.join(groupId);
      socket.emit("group:joined", { groupId, group });
      io.emit("groups:update", Array.from(groups.values()));
      return;
    }

    // Notify group admin
    const adminSocket = Array.from(io.sockets.sockets.values()).find(
      (s) => activeUsers.get(s.id)?.id === group.adminId
    );

    if (adminSocket) {
      adminSocket.emit("group:join-request", {
        groupId,
        user,
      });
    }
  });

  socket.on("group:join-response", ({ groupId, userId, accepted }) => {
    const group = groups.get(groupId);
    if (!group || !isGroupAdmin(groupId, activeUsers.get(socket.id)?.id))
      return;

    if (accepted) {
      group.members.push(userId);
      io.emit("groups:update", Array.from(groups.values()));

      // Notify user
      const userSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => activeUsers.get(s.id)?.id === userId
      );

      if (userSocket) {
        userSocket.emit("group:joined", { groupId, group });
      }
    }
  });

  // Handle member removal by admin
  socket.on("group:remove-member", ({ groupId, userId }) => {
    const group = groups.get(groupId);
    if (!group || !isGroupAdmin(groupId, activeUsers.get(socket.id)?.id))
      return;

    const memberIndex = group.members.indexOf(userId);
    if (memberIndex > -1) {
      group.members.splice(memberIndex, 1);

      // Remove user from all group rooms
      group.rooms.forEach((roomId) => {
        const room = rooms.get(roomId);
        if (room) {
          const roomMemberIndex = room.members.indexOf(userId);
          if (roomMemberIndex > -1) {
            room.members.splice(roomMemberIndex, 1);
          }
        }
      });

      io.emit("groups:update", Array.from(groups.values()));
      io.to(groupId).emit("member:removed", { groupId, userId });
    }
  });

  socket.on("groups:fetch", () => {
    // Send all groups to the client
    socket.emit("groups:update", Array.from(groups.values()));
  });

  socket.on("group:fetch", ({ groupId, userId }) => {
    try {
      console.log("Fetching group:", groupId, "for user:", userId);
      const user = activeUsers.get(socket.id);
      const group = groups.get(groupId);

      if (!user) {
        console.log("User not found in active users");
        socket.emit("error", "Authentication required");
        return;
      }

      if (!group) {
        console.log("Group not found:", groupId);
        socket.emit("error", "Group not found");
        return;
      }

      // Send group data first
      socket.emit("group:info", group);

      // Then send rooms data
      const groupRooms = Array.from(rooms.values()).filter(
        (room) => room.groupId === groupId
      );

      socket.emit("rooms:update", {
        groupId,
        rooms: groupRooms,
      });
    } catch (error) {
      console.error("Error in group:fetch:", error);
      socket.emit("error", "Failed to load group data");
    }
  });

  // Handle room join
  socket.on('room:join', ({ roomId, user }) => {
    const room = rooms.get(roomId);
    if (!room) return;
  
    socket.join(roomId);
    
    // Mark all existing messages as seen by this user
    room.messages.forEach(msg => {
      if (!msg.seenBy.includes(user.id)) {
        msg.seenBy.push(user.id);
        io.to(roomId).emit('message:seen:update', { 
          messageId: msg.id, 
          seenBy: msg.seenBy 
        });
      }
    });
  
    socket.emit('room:info', {
      ...room,
      memberCount: room.members.length,
      activeMembers: io.sockets.adapter.rooms.get(roomId)?.size || 0
    });
    socket.emit('message:history', room.messages);
  });

  socket.on("room:update-permissions", ({ roomId, permissions }) => {
    const room = rooms.get(roomId);
    if (!room || !isGroupAdmin(room.groupId, activeUsers.get(socket.id)?.id))
      return;

    room.permissions = {
      ...room.permissions,
      ...permissions,
    };

    io.to(room.groupId).emit("rooms:update", {
      groupId: room.groupId,
      rooms: groups.get(room.groupId).rooms.map((id) => rooms.get(id)),
    });
  });

  // Handle room leave
  socket.on("room:leave", ({ roomId, user }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.activeMembers.delete(user.id);
      socket.leave(roomId);
    }
  });

  // Handle join requests for private rooms
  socket.on("room:join-request", ({ roomId, userId }) => {
    const room = rooms.get(roomId);
    if (room && room.isPrivate) {
      const creatorSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => activeUsers.get(s.id)?.id === room.creator.id
      );

      if (creatorSocket) {
        creatorSocket.emit("room:join-request", {
          roomId,
          user: activeUsers.get(socket.id),
        });
      }
    }
  });

  // Handle join request response
  socket.on("room:join-response", ({ roomId, userId, accepted }) => {
    const room = rooms.get(roomId);
    if (room && accepted) {
      room.members.push(userId);
      io.emit("rooms:update", Array.from(rooms.values()));

      // Notify requesting user
      const userSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => activeUsers.get(s.id)?.id === userId
      );

      if (userSocket) {
        userSocket.emit("room:join-response", { roomId, accepted });
      }
    }
  });

  // Handle user typing
  socket.on("user:typing", ({ roomId, userId, username }) => {
    socket.to(roomId).emit("user:typing", { userId, username });
  });

  // Handle user stopped typing
  socket.on("user:stop-typing", ({ roomId, userId }) => {
    socket.to(roomId).emit("user:stop-typing", { userId });
  });

  // Handle messages
  socket.on("message:send", ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const newMessage = {
      ...message,
      id: Date.now().toString(), // Ensure unique ID
      timestamp: new Date().toISOString(),
      seenBy: [message.sender.id], // Initialize with sender
    };

    room.messages.push(newMessage);
    io.to(roomId).emit("message:received", newMessage);
  });

  // Add seen message handler
  socket.on("message:seen", ({ roomId, messageId, user }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const message = room.messages.find((m) => m.id === messageId);
    if (message && !message.seenBy.includes(user.id)) {
      message.seenBy.push(user.id);
      io.to(roomId).emit("message:seen:update", {
        messageId,
        seenBy: message.seenBy,
      });
    }
  });

  // Handle user logout
  socket.on("user:disconnect", (user) => {
    if (user && userSockets.has(user.id)) {
      const userSocketIds = userSockets.get(user.id);
      userSocketIds.forEach((socketId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.rooms.forEach((roomId) => {
            if (roomId !== socketId) {
              updateRoomInfo(roomId);
            }
          });
          socket.disconnect();
        }
      });

      userSockets.delete(user.id);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      // Remove this socket from user's sockets
      if (userSockets.has(user.id)) {
        userSockets.get(user.id).delete(socket.id);
      }

      // Update room information for all rooms this socket was in
      socket.rooms.forEach((roomId) => {
        if (roomId !== socket.id) {
          updateRoomInfo(roomId);
        }
      });

      // Clean up if this was user's last socket
      if (!userSockets.get(user.id)?.size) {
        userSockets.delete(user.id);
      }

      activeUsers.delete(socket.id);
      sessions.delete(socket.id);
    }
    console.log("User disconnected:", socket.id);
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
