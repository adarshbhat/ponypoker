import express from 'express'
import type { Application, Request, Response } from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { v4 as uuidv4 } from 'uuid'

// Data Types
export interface User {
    id: string
    name: string
    role: 'player' | 'observer'
}

export interface Ticket {
    id: string
    title: string
    description: string
    votes: Record<string, number | null>
    revealed: boolean
}

export interface TeamSession {
    code: string
    users: User[]
    tickets: Ticket[]
    selectedTicketId: string | null
    votingRevealed: boolean
}

export interface VoteAnalysis {
    consensus: boolean
    mode: number | null
    median: number
    distribution: Record<number, string[]>
    recommendedPoint: number
}

// WebSocket message types
export type ClientMessage =
    | { type: 'join'; teamCode: string; name: string; role: 'player' | 'observer'; userId?: string }
    | { type: 'addTicket'; title: string; description: string }
    | { type: 'selectTicket'; ticketId: string }
    | { type: 'vote'; points: number }
    | { type: 'revealVotes' }
    | { type: 'resetVotes' }
    | { type: 'leave' }

export type ServerMessage =
    | { type: 'sessionState'; session: TeamSession; userId: string }
    | { type: 'userJoined'; user: User }
    | { type: 'userLeft'; userId: string }
    | { type: 'ticketAdded'; ticket: Ticket }
    | { type: 'ticketSelected'; ticket: Ticket; votedCount: number; totalPlayers: number }
    | { type: 'voteReceived'; ticketId: string; votedCount: number; totalPlayers: number; voterId?: string }
    | { type: 'votesRevealed'; ticket: Ticket; average: number; analysis: VoteAnalysis }
    | { type: 'votesReset'; ticketId: string }
    | { type: 'error'; message: string }

// In-memory store
export const sessions: Record<string, TeamSession> = {}
export const clientSessions: Map<WebSocket, { sessionCode: string; userId: string }> = new Map()

export const POINT_VALUES = [1, 2, 3, 5, 8, 13]

export function createApp(): Application {
    const app: Application = express()
    app.use(express.json())
    app.use(express.static('dist'))
    return app
}

function broadcast(sessionCode: string, message: ServerMessage, wss: WebSocketServer, excludeWs?: WebSocket): void {
    const data = JSON.stringify(message)
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            const clientInfo = clientSessions.get(client)
            if (clientInfo?.sessionCode === sessionCode) {
                client.send(data)
            }
        }
    })
}

function getPlayerCount(session: TeamSession): number {
    return session.users.filter(u => u.role === 'player').length
}

function getVoteCount(ticket: Ticket, session: TeamSession): number {
    const playerIds = session.users.filter(u => u.role === 'player').map(u => u.id)
    return Object.entries(ticket.votes).filter(([id, v]) => playerIds.includes(id) && v !== null).length
}

function calculateAverage(ticket: Ticket): number {
    const values = Object.values(ticket.votes).filter((v): v is number => v !== null)
    if (values.length === 0) return 0
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
}

function roundToNearestPoint(value: number): number {
    let closest = POINT_VALUES[0]
    let minDiff = Math.abs(value - closest)
    
    for (const point of POINT_VALUES) {
        const diff = Math.abs(value - point)
        if (diff < minDiff) {
            minDiff = diff
            closest = point
        }
    }
    
    return closest
}

function analyzeVotes(ticket: Ticket, session: TeamSession): VoteAnalysis {
    const playerIds = session.users.filter(u => u.role === 'player').map(u => u.id)
    const votes = Object.entries(ticket.votes)
        .filter(([id, v]) => playerIds.includes(id) && v !== null)
        .map(([id, v]) => ({ userId: id, value: v as number }))
    
    if (votes.length === 0) {
        return {
            consensus: false,
            mode: null,
            median: 0,
            distribution: {},
            recommendedPoint: 0
        }
    }
    
    // Build distribution: vote value -> array of user IDs
    const distribution: Record<number, string[]> = {}
    for (const vote of votes) {
        if (!distribution[vote.value]) {
            distribution[vote.value] = []
        }
        distribution[vote.value].push(vote.userId)
    }
    
    // Check consensus (all votes are the same)
    const uniqueVotes = Object.keys(distribution).length
    const consensus = uniqueVotes === 1
    
    // Find mode (most common vote)
    let mode: number | null = null
    let maxCount = 0
    for (const [value, userIds] of Object.entries(distribution)) {
        if (userIds.length > maxCount) {
            maxCount = userIds.length
            mode = Number(value)
        }
    }
    
    // Calculate median
    const sortedValues = votes.map(v => v.value).sort((a, b) => a - b)
    const mid = Math.floor(sortedValues.length / 2)
    const median = sortedValues.length % 2 === 0
        ? (sortedValues[mid - 1] + sortedValues[mid]) / 2
        : sortedValues[mid]
    
    // Calculate recommended story point using smart algorithm
    let recommendedPoint: number
    if (consensus) {
        // 100% consensus - use that value
        recommendedPoint = mode!
    } else if (mode !== null && maxCount > votes.length / 2) {
        // Clear majority (>50%) - use mode
        recommendedPoint = mode
    } else {
        // No clear winner - use median rounded to nearest valid point
        recommendedPoint = roundToNearestPoint(median)
    }
    
    return {
        consensus,
        mode,
        median,
        distribution,
        recommendedPoint
    }
}

export function handleMessage(ws: WebSocket, message: ClientMessage, wss: WebSocketServer): void {
    switch (message.type) {
        case 'join': {
            const { teamCode, name, role, userId } = message
            
            // Create session if it doesn't exist
            if (!sessions[teamCode]) {
                sessions[teamCode] = {
                    code: teamCode,
                    users: [],
                    tickets: [],
                    selectedTicketId: null,
                    votingRevealed: false
                }
            }
            
            const session = sessions[teamCode]
            
            // First, try to find existing user by userId for reconnection
            let user = userId ? session.users.find(u => u.id === userId) : undefined
            if (user) {
                user.name = name
                user.role = role
            } else {
                // Remove any existing user with the same name to prevent duplicates
                const existingUserIndex = session.users.findIndex(u => u.name === name)
                if (existingUserIndex !== -1) {
                    const removedUser = session.users.splice(existingUserIndex, 1)[0]
                    // Notify others that the old user left
                    broadcast(teamCode, { type: 'userLeft', userId: removedUser.id }, wss, ws)
                }
                
                user = { id: uuidv4(), name, role }
                session.users.push(user)
            }
            
            clientSessions.set(ws, { sessionCode: teamCode, userId: user.id })
            
            // Send full state to joining user
            ws.send(JSON.stringify({ type: 'sessionState', session, userId: user.id } as ServerMessage))
            
            // Notify others
            broadcast(teamCode, { type: 'userJoined', user }, wss, ws)
            break
        }

        case 'leave': {
            handleDisconnect(ws, wss)
            break
        }
        
        case 'addTicket': {
            const clientInfo = clientSessions.get(ws)
            if (!clientInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' } as ServerMessage))
                return
            }
            
            const session = sessions[clientInfo.sessionCode]
            const user = session.users.find(u => u.id === clientInfo.userId)
            if (!user || user.role !== 'observer') {
                ws.send(JSON.stringify({ type: 'error', message: 'Only observers can add tickets' } as ServerMessage))
                return
            }
            const ticket: Ticket = {
                id: uuidv4(),
                title: message.title,
                description: message.description,
                votes: {},
                revealed: false
            }
            session.tickets.push(ticket)
            
            broadcast(clientInfo.sessionCode, { type: 'ticketAdded', ticket }, wss)
            break
        }
        
        case 'selectTicket': {
            const clientInfo = clientSessions.get(ws)
            if (!clientInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' } as ServerMessage))
                return
            }
            
            const session = sessions[clientInfo.sessionCode]
            const user = session.users.find(u => u.id === clientInfo.userId)
            if (!user || user.role !== 'observer') {
                ws.send(JSON.stringify({ type: 'error', message: 'Only observers can select tickets' } as ServerMessage))
                return
            }
            const ticket = session.tickets.find(t => t.id === message.ticketId)
            if (!ticket) {
                ws.send(JSON.stringify({ type: 'error', message: 'Ticket not found' } as ServerMessage))
                return
            }
            
            session.selectedTicketId = message.ticketId
            session.votingRevealed = ticket.revealed

            const votedCount = getVoteCount(ticket, session)
            const totalPlayers = getPlayerCount(session)
            broadcast(clientInfo.sessionCode, { type: 'ticketSelected', ticket, votedCount, totalPlayers }, wss)
            break
        }
        
        case 'vote': {
            const clientInfo = clientSessions.get(ws)
            if (!clientInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' } as ServerMessage))
                return
            }
            
            const session = sessions[clientInfo.sessionCode]
            const user = session.users.find(u => u.id === clientInfo.userId)
            
            if (!user || user.role !== 'player') {
                ws.send(JSON.stringify({ type: 'error', message: 'Only players can vote' } as ServerMessage))
                return
            }
            
            if (!session.selectedTicketId) {
                ws.send(JSON.stringify({ type: 'error', message: 'No ticket selected' } as ServerMessage))
                return
            }
            
            if (!POINT_VALUES.includes(message.points)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid point value' } as ServerMessage))
                return
            }
            
            const ticket = session.tickets.find(t => t.id === session.selectedTicketId)
            if (!ticket) {
                ws.send(JSON.stringify({ type: 'error', message: 'Ticket not found' } as ServerMessage))
                return
            }
            
            ticket.votes[clientInfo.userId] = message.points
            
            const votedCount = getVoteCount(ticket, session)
            const totalPlayers = getPlayerCount(session)
            
            broadcast(clientInfo.sessionCode, {
                type: 'voteReceived',
                ticketId: ticket.id,
                votedCount,
                totalPlayers,
                voterId: clientInfo.userId
            }, wss)
            
            // Auto-reveal if all players voted
            if (votedCount === totalPlayers && totalPlayers > 0) {
                session.votingRevealed = true
                ticket.revealed = true
                const average = calculateAverage(ticket)
                const analysis = analyzeVotes(ticket, session)
                broadcast(clientInfo.sessionCode, { type: 'votesRevealed', ticket, average, analysis }, wss)
            }
            break
        }
        
        case 'revealVotes': {
            const clientInfo = clientSessions.get(ws)
            if (!clientInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' } as ServerMessage))
                return
            }
            
            const session = sessions[clientInfo.sessionCode]
            const user = session.users.find(u => u.id === clientInfo.userId)
            if (!user || user.role !== 'observer') {
                ws.send(JSON.stringify({ type: 'error', message: 'Only observers can reveal votes' } as ServerMessage))
                return
            }
            if (!session.selectedTicketId) {
                ws.send(JSON.stringify({ type: 'error', message: 'No ticket selected' } as ServerMessage))
                return
            }
            
            const ticket = session.tickets.find(t => t.id === session.selectedTicketId)
            if (!ticket) {
                ws.send(JSON.stringify({ type: 'error', message: 'Ticket not found' } as ServerMessage))
                return
            }
            
            session.votingRevealed = true
            ticket.revealed = true
            const average = calculateAverage(ticket)
            const analysis = analyzeVotes(ticket, session)
            broadcast(clientInfo.sessionCode, { type: 'votesRevealed', ticket, average, analysis }, wss)
            break
        }
        
        case 'resetVotes': {
            const clientInfo = clientSessions.get(ws)
            if (!clientInfo) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not in a session' } as ServerMessage))
                return
            }
            
            const session = sessions[clientInfo.sessionCode]
            const user = session.users.find(u => u.id === clientInfo.userId)
            if (!user || user.role !== 'observer') {
                ws.send(JSON.stringify({ type: 'error', message: 'Only observers can reset votes' } as ServerMessage))
                return
            }
            if (!session.selectedTicketId) {
                ws.send(JSON.stringify({ type: 'error', message: 'No ticket selected' } as ServerMessage))
                return
            }
            
            const ticket = session.tickets.find(t => t.id === session.selectedTicketId)
            if (!ticket) {
                ws.send(JSON.stringify({ type: 'error', message: 'Ticket not found' } as ServerMessage))
                return
            }
            
            ticket.votes = {}
            session.votingRevealed = false
            ticket.revealed = false
            broadcast(clientInfo.sessionCode, { type: 'votesReset', ticketId: ticket.id }, wss)
            break
        }
    }
}

export function handleDisconnect(ws: WebSocket, wss: WebSocketServer): void {
    const clientInfo = clientSessions.get(ws)
    if (clientInfo) {
        const session = sessions[clientInfo.sessionCode]
        if (session) {
            const userIndex = session.users.findIndex(u => u.id === clientInfo.userId)
            if (userIndex !== -1) {
                session.users.splice(userIndex, 1)
                broadcast(clientInfo.sessionCode, { type: 'userLeft', userId: clientInfo.userId }, wss)
            }
            
            // Clean up empty sessions
            if (session.users.length === 0) {
                delete sessions[clientInfo.sessionCode]
            }
        }
        clientSessions.delete(ws)
    }
}

export function setupWebSocket(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => {
        ws.on('message', (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString()) as ClientMessage
                handleMessage(ws, message, wss)
            } catch {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' } as ServerMessage))
            }
        })
        
        ws.on('close', () => {
            handleDisconnect(ws, wss)
        })
    })
}


const app: Application = createApp()
const server = createServer(app)
const wss = new WebSocketServer({ server })

setupWebSocket(wss)

const port = 3000
server.listen(port, '0.0.0.0', () => {
    console.log(`Pony Poker server listening on port ${port}`)
})
