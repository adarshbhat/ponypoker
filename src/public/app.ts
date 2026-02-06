/// <reference lib="dom" />

// Types
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

export type ClientMessage =
    | { type: 'join'; teamCode: string; name: string; role: 'player' | 'observer'; userId?: string }
    | { type: 'addTicket'; title: string; description: string }
    | { type: 'selectTicket'; ticketId: string }
    | { type: 'vote'; points: number }
    | { type: 'revealVotes' }
    | { type: 'resetVotes' }
    | { type: 'leave' }

const POINT_VALUES = [1, 2, 3, 5, 8, 13]

const TEAM_DISPLAY_NAMES: Record<string, string> = {
    'git-gurus': 'Git Gurus',
    'never-ponies': 'Never Ponies',
    'nextgen': 'NextGen',
    'rainbow-cloudies': 'Rainbow Cloudies'
}

type SuitName = 'spades' | 'hearts' | 'clubs' | 'diamonds'

interface CardVisual {
    label: string
    suitSymbol: string
    color: 'red' | 'black'
    pipPositions: Array<{ x: number; y: number }>
    isFace: boolean
}

// App State
export interface AppState {
    ws: WebSocket | null
    userId: string | null
    session: TeamSession | null
    myVote: number | null
    votedCount: number
    totalPlayers: number
    votedUsers: Record<string, boolean>
}

export const state: AppState = {
    ws: null,
    userId: null,
    session: null,
    myVote: null,
    votedCount: 0,
    totalPlayers: 0
    ,votedUsers: {}
}

// DOM Elements
function getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null
}

function getTeamDisplayName(teamCode: string): string {
    return TEAM_DISPLAY_NAMES[teamCode] ?? teamCode
}

function updateTeamName(teamCode: string | null): void {
    const teamNameEl = getElement<HTMLElement>('team-name')
    if (!teamNameEl) return

    if (!teamCode) {
        teamNameEl.textContent = ''
        teamNameEl.classList.add('hidden')
        return
    }

    teamNameEl.textContent = getTeamDisplayName(teamCode)
    teamNameEl.classList.remove('hidden')
}

// WebSocket Connection
export function connectWebSocket(): WebSocket {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    const ws = new WebSocket(wsUrl)
    
    ws.onopen = () => {
        updateConnectionStatus('connected')
        
        // Rejoin if we have saved session info
        const savedName = localStorage.getItem('ponypoker_name')
        const savedTeamCode = localStorage.getItem('ponypoker_teamCode')
        const savedRole = localStorage.getItem('ponypoker_role') as 'player' | 'observer' | null
        const savedUserId = localStorage.getItem('ponypoker_userId') || undefined
        
        if (savedName && savedTeamCode && savedRole) {
            sendMessage({ type: 'join', teamCode: savedTeamCode, name: savedName, role: savedRole, userId: savedUserId })
        }
    }
    
    ws.onclose = () => {
        updateConnectionStatus('disconnected')
        // Attempt reconnection after 3 seconds
        setTimeout(() => {
            state.ws = connectWebSocket()
        }, 3000)
    }
    
    ws.onerror = () => {
        updateConnectionStatus('disconnected')
    }
    
    ws.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data) as ServerMessage
        handleServerMessage(message)
    }
    
    state.ws = ws
    return ws
}

export function sendMessage(message: ClientMessage): void {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(message))
    }
}

function updateConnectionStatus(status: 'connected' | 'disconnected' | 'connecting'): void {
    const statusEl = getElement<HTMLDivElement>('connection-status')
    if (statusEl) {
        statusEl.className = `status-indicator ${status}`
        statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1)
    }
}

// Message Handlers
export function handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
        case 'sessionState':
            state.session = message.session
            state.userId = message.userId
            try { localStorage.setItem('ponypoker_userId', message.userId) } catch {}
            state.totalPlayers = message.session.users.filter(u => u.role === 'player').length
            state.votedUsers = {}
            state.votedCount = 0
            state.myVote = null
            updateTeamName(message.session.code)
            if (message.session.selectedTicketId) {
                const selectedTicket = message.session.tickets.find(t => t.id === message.session?.selectedTicketId)
                if (selectedTicket) {
                    state.session.votingRevealed = selectedTicket.revealed
                    const playerIds = new Set(message.session.users.filter(u => u.role === 'player').map(u => u.id))
                    const votedUsers: Record<string, boolean> = {}
                    Object.entries(selectedTicket.votes).forEach(([userId, vote]) => {
                        if (playerIds.has(userId) && vote !== null) {
                            votedUsers[userId] = true
                        }
                    })
                    state.votedUsers = votedUsers
                    state.votedCount = Object.keys(votedUsers).length
                    if (state.userId && selectedTicket.votes[state.userId] !== undefined) {
                        const myVote = selectedTicket.votes[state.userId]
                        state.myVote = typeof myVote === 'number' ? myVote : null
                    }
                }
            }
            showScreen('session-screen')
            renderMembers()
            renderTickets()
            updateVotingSection()
            updateObserverControls()
            if (state.session.selectedTicketId) {
                const selectedTicket = state.session.tickets.find(t => t.id === state.session?.selectedTicketId)
                if (selectedTicket?.revealed) {
                    showResults(selectedTicket, calculateAverage(selectedTicket))
                }
            }
            break
            
        case 'userJoined':
            if (state.session) {
                const existingIndex = state.session.users.findIndex(u => u.id === message.user.id)
                if (existingIndex >= 0) {
                    state.session.users[existingIndex] = message.user
                } else {
                    state.session.users.push(message.user)
                }
                state.totalPlayers = state.session.users.filter(u => u.role === 'player').length
                renderMembers()
                updateVoteStatus()
                updateObserverControls()
            }
            break
            
        case 'userLeft':
            if (state.session) {
                state.session.users = state.session.users.filter(u => u.id !== message.userId)
                state.totalPlayers = state.session.users.filter(u => u.role === 'player').length
                // remove from votedUsers if present
                if (state.votedUsers && state.votedUsers[message.userId]) {
                    delete state.votedUsers[message.userId]
                }
                renderMembers()
                updateVoteStatus()
                updateObserverControls()
            }
            break
            
        case 'ticketAdded':
            if (state.session) {
                state.session.tickets.push(message.ticket)
                renderTickets()
            }
            break
            
        case 'ticketSelected':
            if (state.session) {
                state.session.selectedTicketId = message.ticket.id
                state.session.votingRevealed = message.ticket.revealed
                const existingIndex = state.session.tickets.findIndex(t => t.id === message.ticket.id)
                if (existingIndex >= 0) {
                    state.session.tickets[existingIndex] = message.ticket
                } else {
                    state.session.tickets.push(message.ticket)
                }
                const playerIds = new Set(state.session.users.filter(u => u.role === 'player').map(u => u.id))
                const votedUsers: Record<string, boolean> = {}
                Object.entries(message.ticket.votes).forEach(([userId, vote]) => {
                    if (playerIds.has(userId) && vote !== null) {
                        votedUsers[userId] = true
                    }
                })
                state.votedUsers = votedUsers
                state.votedCount = message.votedCount
                state.totalPlayers = message.totalPlayers
                if (state.userId && message.ticket.votes[state.userId] !== undefined) {
                    const myVote = message.ticket.votes[state.userId]
                    state.myVote = typeof myVote === 'number' ? myVote : null
                } else {
                    state.myVote = null
                }
                renderTickets()
                updateVotingSection()
                updateObserverControls()
                renderMembers()
                if (message.ticket.revealed) {
                    const analysis = analyzeVotes(message.ticket)
                    showResults(message.ticket, calculateAverage(message.ticket), analysis)
                }
            }
            break
            
        case 'voteReceived':
            state.votedCount = message.votedCount
            state.totalPlayers = message.totalPlayers
            if (message.voterId) {
                state.votedUsers = state.votedUsers || {}
                state.votedUsers[message.voterId] = true
            }
            updateVoteStatus()
            renderMembers()
            break
            
        case 'votesRevealed':
            if (state.session) {
                state.session.votingRevealed = true
                const ticket = state.session.tickets.find(t => t.id === message.ticket.id)
                if (ticket) {
                    ticket.votes = message.ticket.votes
                    ticket.revealed = true
                }
                showResults(message.ticket, message.average, message.analysis)
                // clear in-progress voted markers since actual votes are visible now
                state.votedUsers = {}
            }
            break
            
        case 'votesReset':
            if (state.session) {
                const ticket = state.session.tickets.find(t => t.id === message.ticketId)
                if (ticket) {
                    ticket.votes = {}
                    ticket.revealed = false
                }
                state.session.votingRevealed = false
                state.myVote = null
                state.votedCount = 0
                state.votedUsers = {}
                updateVotingSection()
                renderMembers()
            }
            break
            
        case 'error':
            showError(message.message)
            break
    }
}

// UI Rendering
function showScreen(screenId: string): void {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active')
    })
    getElement<HTMLElement>(screenId)?.classList.add('active')
}

export function renderMembers(): void {
    const listEl = getElement<HTMLUListElement>('members-list')
    const session = state.session
    if (!listEl || !session) return

    const users: User[] = [...session.users]

    users.sort((a: User, b: User): number => {
        const isMeA: boolean = a.id === state.userId
        const isMeB: boolean = b.id === state.userId
        if (isMeA !== isMeB) {
            return isMeA ? -1 : 1
        }

        const roleRank = (user: User): number => (user.role === 'player' ? 0 : 1)
        const roleDiff: number = roleRank(a) - roleRank(b)
        if (roleDiff !== 0) {
            return roleDiff
        }

        const nameA: string = a.name.toLocaleLowerCase()
        const nameB: string = b.name.toLocaleLowerCase()
        if (nameA < nameB) return -1
        if (nameA > nameB) return 1
        return 0
    })

    listEl.innerHTML = users.map(user => {
        const ticketSelected = Boolean(session.selectedTicketId)
        const ticket = ticketSelected ? session.tickets.find(t => t.id === session.selectedTicketId) : null
        const hasVoted = Boolean(state.votedUsers && state.votedUsers[user.id]) || (session.votingRevealed && ticket ? (ticket.votes[user.id] !== undefined && ticket.votes[user.id] !== null) : false)

        let voteIndicator = ''
        if (user.role === 'observer') {
            voteIndicator = '👀'
        } else if (!ticketSelected) {
            voteIndicator = ''
        } else if (state.session?.votingRevealed) {
            voteIndicator = '✅'
        } else if (hasVoted) {
            voteIndicator = '✅'
        } else {
            voteIndicator = '⏳'
        }
        const isMe = user.id === state.userId
        
        return `
            <li class="${user.role}">
                <span>${user.name}${isMe ? ' (you)' : ''}</span>
                <span class="role-badge">${user.role}</span>
                <span class="vote-indicator">${voteIndicator}</span>
            </li>
        `
    }).join('')
}

export function renderTickets(): void {
    const listEl = getElement<HTMLUListElement>('tickets-list')
    if (!listEl || !state.session) return
    const isObserver = isCurrentObserver()

    if (state.session.tickets.length === 0) {
        const message = isObserver
            ? 'No tickets yet. Add one to get started!'
            : 'No tickets yet. Please wait for the observer to add tickets.'

        listEl.innerHTML = `<li class="empty-state">${message}</li>`
        return
    }

    // Players should only see the currently selected ticket; observers see all tickets
    let ticketsToRender: Ticket[] = []
    if (isObserver) {
        ticketsToRender = state.session.tickets
    } else {
        const selectedId = state.session.selectedTicketId
        if (!selectedId) {
            listEl.innerHTML = `<li class="empty-state">Please wait for the observer to select a ticket.</li>`
            return
        }
        const sel = state.session.tickets.find(t => t.id === selectedId)
        if (!sel) {
            listEl.innerHTML = `<li class="empty-state">Selected ticket not found.</li>`
            return
        }
        ticketsToRender = [sel]
    }

    listEl.innerHTML = ticketsToRender.map(ticket => `
        <li class="${ticket.id === state.session?.selectedTicketId ? 'selected' : ''}" 
            data-ticket-id="${ticket.id}">
            <div class="ticket-title">
                ${ticket.revealed ? '<span class="ticket-voted-icon" title="Voted">✓</span>' : ''}
                ${escapeHtml(ticket.title)}
            </div>
            ${ticket.description ? `<div class="ticket-desc">${escapeHtml(ticket.description)}</div>` : ''}
        </li>
    `).join('')

    // Only observers get click-to-select behavior
    if (isObserver) {
        listEl.querySelectorAll('li[data-ticket-id]').forEach(li => {
            li.addEventListener('click', () => {
                const ticketId = li.getAttribute('data-ticket-id')
                if (ticketId) {
                    sendMessage({ type: 'selectTicket', ticketId })
                }
            })
        })
    }
}

function updateVotingSection(): void {
    const votingSection = getElement<HTMLDivElement>('voting-section')
    const resultsSection = getElement<HTMLDivElement>('results-section')
    
    if (!votingSection || !state.session) return
    
    if (!state.session.selectedTicketId) {
        votingSection.classList.add('hidden')
        return
    }
    
    const ticket = state.session.tickets.find(t => t.id === state.session?.selectedTicketId)
    if (!ticket) return
    
    votingSection.classList.remove('hidden')
    resultsSection?.classList.add('hidden')
    
    const titleEl = getElement<HTMLSpanElement>('selected-ticket-title')
    const descEl = getElement<HTMLParagraphElement>('selected-ticket-description')
    
    if (titleEl) titleEl.textContent = ticket.title
    if (descEl) descEl.textContent = ticket.description || ''
    
    renderPointCards()
    updateVoteStatus()
}

function renderPointCards(): void {
    const container = getElement<HTMLDivElement>('point-cards')
    if (!container) return
    
    const currentUser = state.session?.users.find(u => u.id === state.userId)
    const isPlayer = currentUser?.role === 'player'
    
    container.innerHTML = POINT_VALUES.map(points => `
        <button class="point-card ${state.myVote === points ? 'selected' : ''}"
                data-points="${points}"
                aria-label="Vote ${points} points"
                title="${points} points"
                ${!isPlayer ? 'disabled' : ''}>
            ${getCardSvg(points)}
        </button>
    `).join('')
    
    container.querySelectorAll('.point-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const points = parseInt(btn.getAttribute('data-points') || '0', 10)
            state.myVote = points
            sendMessage({ type: 'vote', points })
            renderPointCards()
        })
    })
}

function getCardSvg(points: number): string {
    const visual = getCardVisual(points)
    const cornerLabel = visual.label
    const suit = visual.suitSymbol
    const fill = visual.color === 'red' ? '#b71c1c' : '#1f2528'
    const pipFill = visual.color === 'red' ? '#c62828' : '#1f2528'

    const pips = visual.pipPositions
        .map(({ x, y }) => `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="32" fill="${pipFill}">${suit}</text>`)
        .join('')

    const faceCenter = visual.isFace
        ? `
            <text x="100" y="150" text-anchor="middle" dominant-baseline="middle" font-size="108" font-weight="700" fill="${fill}">${visual.label}</text>
            <text x="100" y="220" text-anchor="middle" dominant-baseline="middle" font-size="54" fill="${pipFill}">${visual.suitSymbol}</text>
        `
        : pips

    return `
        <svg class="card-svg" viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
            <rect x="6" y="6" width="188" height="268" rx="16" fill="#ffffff" stroke="#e0e0e0" stroke-width="2" />
            <rect x="14" y="14" width="172" height="252" rx="12" fill="#ffffff" stroke="#f1f2f6" stroke-width="2" />
            <text x="22" y="36" font-size="26" font-weight="700" fill="${fill}">${cornerLabel}</text>
            <text x="22" y="64" font-size="24" fill="${pipFill}">${suit}</text>
            <g transform="rotate(180 100 140)">
                <text x="22" y="36" font-size="26" font-weight="700" fill="${fill}">${cornerLabel}</text>
                <text x="22" y="64" font-size="24" fill="${pipFill}">${suit}</text>
            </g>
            ${faceCenter}
        </svg>
    `
}

function getFaceCenterSvg(visual: CardVisual, fill: string, pipFill: string): string {
    if (visual.label === 'K') {
        return `
            ${getOrnateKSvg(fill)}
            <text x="100" y="214" text-anchor="middle" dominant-baseline="middle" font-size="54" fill="${pipFill}">${visual.suitSymbol}</text>
        `
    }

    return `
        <text x="100" y="150" text-anchor="middle" dominant-baseline="middle" font-size="108" font-weight="700" fill="${fill}">${visual.label}</text>
        <text x="100" y="220" text-anchor="middle" dominant-baseline="middle" font-size="54" fill="${pipFill}">${visual.suitSymbol}</text>
    `
}

function getOrnateKSvg(fill: string): string {
    return `
        <g transform="translate(28 44)">
            <path d="M18 0 L56 0 L70 18 L70 176 L56 196 L18 196 L6 176 L6 18 Z" fill="${fill}" />
            <path d="M70 84 L152 10 L172 28 L96 98 L70 98 Z" fill="${fill}" />
            <path d="M70 98 L96 98 L172 168 L152 186 L70 112 Z" fill="${fill}" />
            <path d="M18 0 L36 20 L6 20 Z" fill="${fill}" />
            <path d="M18 196 L36 176 L6 176 Z" fill="${fill}" />
            <path d="M152 10 L166 -2 L184 14 L172 28 Z" fill="${fill}" />
            <path d="M152 186 L172 168 L184 182 L166 198 Z" fill="${fill}" />
            <path d="M70 84 L96 64 L120 84 L94 104 Z" fill="#ffffff" fill-opacity="0.16" />
        </g>
    `
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

function analyzeVotes(ticket: Ticket): VoteAnalysis {
    if (!state.session) {
        return {
            consensus: false,
            mode: null,
            median: 0,
            distribution: {},
            recommendedPoint: 0
        }
    }
    
    const playerIds = state.session.users.filter(u => u.role === 'player').map(u => u.id)
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

function getCardVisual(points: number): CardVisual {
    const suitMap: Record<number, SuitName> = {
        1: 'spades',
        2: 'hearts',
        3: 'clubs',
        5: 'diamonds',
        8: 'spades',
        13: 'hearts'
    }

    const suitSymbols: Record<SuitName, string> = {
        spades: '♠',
        hearts: '♥',
        clubs: '♣',
        diamonds: '♦'
    }

    const color = suitMap[points] === 'hearts' || suitMap[points] === 'diamonds' ? 'red' : 'black'
    const label = points === 1 ? 'A' : points === 13 ? 'K' : String(points)

    const pipLayouts: Record<number, Array<{ x: number; y: number }>> = {
        1: [{ x: 100, y: 140 }],
        2: [{ x: 100, y: 70 }, { x: 100, y: 210 }],
        3: [{ x: 100, y: 70 }, { x: 100, y: 140 }, { x: 100, y: 210 }],
        5: [{ x: 60, y: 70 }, { x: 140, y: 70 }, { x: 100, y: 140 }, { x: 60, y: 210 }, { x: 140, y: 210 }],
        8: [
            { x: 60, y: 60 }, { x: 140, y: 60 },
            { x: 60, y: 100 }, { x: 140, y: 100 },
            { x: 60, y: 180 }, { x: 140, y: 180 },
            { x: 60, y: 220 }, { x: 140, y: 220 }
        ]
    }

    return {
        label,
        suitSymbol: suitSymbols[suitMap[points] ?? 'spades'],
        color,
        pipPositions: pipLayouts[points] ?? [{ x: 100, y: 140 }],
        isFace: points === 13
    }
}

function updateVoteStatus(): void {
    const statusEl = getElement<HTMLDivElement>('vote-status')
    if (!statusEl) return
    
    if (state.totalPlayers === 0) {
        statusEl.textContent = 'No players in session'
    } else {
        statusEl.textContent = `Votes: ${state.votedCount} / ${state.totalPlayers}`
    }
}

function isCurrentObserver(): boolean {
    const currentUser = state.session?.users.find(u => u.id === state.userId)
    return currentUser?.role === 'observer'
}

function updateObserverControls(): void {
    const addBtn = getElement<HTMLButtonElement>('add-ticket-btn')
    const revealBtn = getElement<HTMLButtonElement>('reveal-btn')
    const resetBtn = getElement<HTMLButtonElement>('reset-btn')

    const isObserver = isCurrentObserver()
    if (addBtn) {
        addBtn.disabled = !isObserver
        addBtn.classList.toggle('hidden', !isObserver)
    }
    if (revealBtn) {
        revealBtn.disabled = !isObserver
        revealBtn.classList.toggle('hidden', !isObserver)
    }
    if (resetBtn) {
        resetBtn.disabled = !isObserver
        resetBtn.classList.toggle('hidden', !isObserver)
    }
}

function showResults(ticket: Ticket, average: number, analysis: VoteAnalysis): void {
    const resultsSection = getElement<HTMLDivElement>('results-section')
    const votesDisplay = getElement<HTMLDivElement>('votes-display')
    const averageDisplay = getElement<HTMLDivElement>('average-display')
    
    if (!resultsSection || !votesDisplay || !averageDisplay || !state.session) return
    
    resultsSection.classList.remove('hidden')
    
    // Build the results display with consensus, recommended point, and grouped votes
    let resultsHtml = ''
    
    // Show consensus banner if all votes match
    if (analysis.consensus && analysis.mode !== null) {
        resultsHtml += `
            <div class="consensus-banner">
                🎯 Consensus: ${analysis.mode} points
            </div>
        `
    }
    
    // Show recommended story point prominently
    resultsHtml += `
        <div class="recommended-point">
            <div class="recommended-label">Recommended Story Point</div>
            <div class="recommended-card">${getCardSvg(analysis.recommendedPoint)}</div>
            <div class="recommended-value">${analysis.recommendedPoint} points</div>
        </div>
    `
    
    // Group votes by card value (sorted descending)
    const voteValues = Object.keys(analysis.distribution)
        .map(v => Number(v))
        .sort((a, b) => b - a)
    
    if (voteValues.length > 0) {
        resultsHtml += '<div class="vote-groups">'
        
        for (const value of voteValues) {
            const userIds = analysis.distribution[value]
            const userNames = userIds
                .map(id => state.session?.users.find(u => u.id === id)?.name || 'Unknown')
                .sort()
            const count = userIds.length
            const plural = count === 1 ? 'vote' : 'votes'
            
            resultsHtml += `
                <div class="vote-group">
                    <div class="vote-group-header">
                        <div class="vote-group-card">${getCardSvg(value)}</div>
                        <div class="vote-group-count">${count} ${plural}</div>
                    </div>
                    <div class="vote-group-players">${userNames.map(n => escapeHtml(n)).join(', ')}</div>
                </div>
            `
        }
        
        resultsHtml += '</div>'
    }
    
    votesDisplay.innerHTML = resultsHtml
    averageDisplay.textContent = `Average: ${average}`
}

function showError(message: string): void {
    const toast = getElement<HTMLDivElement>('error-toast')
    if (!toast) return
    
    toast.textContent = message
    toast.classList.remove('hidden')
    
    setTimeout(() => {
        toast.classList.add('hidden')
    }, 3000)
}

function escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
}

// Event Handlers
export function setupEventHandlers(): void {
    const teamCodeSelect = getElement<HTMLSelectElement>('team-code')
    if (teamCodeSelect) {
        teamCodeSelect.innerHTML = ''
        Object.entries(TEAM_DISPLAY_NAMES).forEach(([code, displayName]: [string, string]) => {
            const option: HTMLOptionElement = document.createElement('option')
            option.value = code
            option.textContent = displayName
            teamCodeSelect.appendChild(option)
        })

        // Preselect saved team if available
        const savedTeamCode = localStorage.getItem('ponypoker_teamCode')
        if (savedTeamCode && TEAM_DISPLAY_NAMES[savedTeamCode]) {
            teamCodeSelect.value = savedTeamCode
        }
    }

    // Join Form
    const joinForm = getElement<HTMLFormElement>('join-form')
    joinForm?.addEventListener('submit', (e: Event) => {
        e.preventDefault()

        const nameInput = getElement<HTMLInputElement>('user-name')
        const teamCodeSelect = getElement<HTMLSelectElement>('team-code')
        const roleInput = document.querySelector<HTMLInputElement>('input[name="role"]:checked')

        const name = nameInput?.value.trim()
        const teamCode = teamCodeSelect?.value.trim()
        const role = roleInput?.value as 'player' | 'observer' | undefined

        if (!name || !teamCode || !role) return

        // Save to localStorage
        localStorage.setItem('ponypoker_name', name)
        localStorage.setItem('ponypoker_teamCode', teamCode)
        localStorage.setItem('ponypoker_role', role)

        const savedUserId = localStorage.getItem('ponypoker_userId') || undefined
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            state.ws = connectWebSocket()
            // Wait for connection to be established
            state.ws.addEventListener('open', () => {
                sendMessage({ type: 'join', teamCode, name, role, userId: savedUserId })
            })
        } else {
            sendMessage({ type: 'join', teamCode, name, role, userId: savedUserId })
        }
    })

    // Leave Button
    getElement<HTMLButtonElement>('leave-btn')?.addEventListener('click', () => {
        sendMessage({ type: 'leave' })
        localStorage.removeItem('ponypoker_teamCode')
        state.session = null
        state.userId = null
        state.ws?.close()
        updateTeamName(null)
        showScreen('join-screen')
    })

    // Add Ticket Modal
    const addTicketBtn = getElement<HTMLButtonElement>('add-ticket-btn')
    const addTicketModal = getElement<HTMLDivElement>('add-ticket-modal')
    const cancelTicketBtn = getElement<HTMLButtonElement>('cancel-ticket-btn')
    const addTicketForm = getElement<HTMLFormElement>('add-ticket-form')

    addTicketBtn?.addEventListener('click', () => {
        if (!isCurrentObserver()) {
            showError('Only observers can add tickets')
            return
        }
        addTicketModal?.classList.remove('hidden')
    })

    cancelTicketBtn?.addEventListener('click', () => {
        addTicketModal?.classList.add('hidden')
    })

    addTicketForm?.addEventListener('submit', (e: Event) => {
        e.preventDefault()

        const titleInput = getElement<HTMLInputElement>('ticket-title')
        const descInput = getElement<HTMLTextAreaElement>('ticket-description')

        const title = titleInput?.value.trim()
        const description = descInput?.value.trim() || ''

        if (!title) return

        sendMessage({ type: 'addTicket', title, description })

        if (titleInput) titleInput.value = ''
        if (descInput) descInput.value = ''
        addTicketModal?.classList.add('hidden')
    })

    // Reveal Votes
    getElement<HTMLButtonElement>('reveal-btn')?.addEventListener('click', () => {
        if (!isCurrentObserver()) {
            showError('Only observers can reveal votes')
            return
        }
        sendMessage({ type: 'revealVotes' })
    })

    // Reset Votes
    getElement<HTMLButtonElement>('reset-btn')?.addEventListener('click', () => {
        if (!isCurrentObserver()) {
            showError('Only observers can reset votes')
            return
        }
        sendMessage({ type: 'resetVotes' })
    })

    window.addEventListener('beforeunload', () => {
        sendMessage({ type: 'leave' })
    })
}

// Initialize
export function initApp(): void {
    // Load saved name into form
    const savedName = localStorage.getItem('ponypoker_name')
    const nameInput = getElement<HTMLInputElement>('user-name')
    if (savedName && nameInput) {
        nameInput.value = savedName
    }
    
    updateConnectionStatus('connecting')
    setupEventHandlers()
    connectWebSocket()
}

document.addEventListener('DOMContentLoaded', initApp)
