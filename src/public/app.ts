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
}

export interface TeamSession {
    code: string
    users: User[]
    tickets: Ticket[]
    selectedTicketId: string | null
    votingRevealed: boolean
}

export type ServerMessage =
    | { type: 'sessionState'; session: TeamSession; userId: string }
    | { type: 'userJoined'; user: User }
    | { type: 'userLeft'; userId: string }
    | { type: 'ticketAdded'; ticket: Ticket }
    | { type: 'ticketSelected'; ticketId: string }
    | { type: 'voteReceived'; ticketId: string; votedCount: number; totalPlayers: number }
    | { type: 'votesRevealed'; ticket: Ticket; average: number }
    | { type: 'votesReset'; ticketId: string }
    | { type: 'error'; message: string }

export type ClientMessage =
    | { type: 'join'; teamCode: string; name: string; role: 'player' | 'observer'; userId?: string }
    | { type: 'addTicket'; title: string; description: string }
    | { type: 'selectTicket'; ticketId: string }
    | { type: 'vote'; points: number }
    | { type: 'revealVotes' }
    | { type: 'resetVotes' }

const POINT_VALUES = [1, 2, 3, 5, 8, 13]

// App State
export interface AppState {
    ws: WebSocket | null
    userId: string | null
    session: TeamSession | null
    myVote: number | null
    votedCount: number
    totalPlayers: number
}

export const state: AppState = {
    ws: null,
    userId: null,
    session: null,
    myVote: null,
    votedCount: 0,
    totalPlayers: 0
}

// DOM Elements
function getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null
}

// WebSocket Connection
export function connectWebSocket(): WebSocket {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api`
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
            state.myVote = null
            state.votedCount = 0
            state.totalPlayers = message.session.users.filter(u => u.role === 'player').length
            showScreen('session-screen')
            renderMembers()
            renderTickets()
            updateVotingSection()
            updateObserverControls()
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
                state.session.selectedTicketId = message.ticketId
                state.session.votingRevealed = false
                state.myVote = null
                state.votedCount = 0
                renderTickets()
                updateVotingSection()
                updateObserverControls()
            }
            break
            
        case 'voteReceived':
            state.votedCount = message.votedCount
            state.totalPlayers = message.totalPlayers
            updateVoteStatus()
            renderMembers()
            break
            
        case 'votesRevealed':
            if (state.session) {
                state.session.votingRevealed = true
                const ticket = state.session.tickets.find(t => t.id === message.ticket.id)
                if (ticket) {
                    ticket.votes = message.ticket.votes
                }
                showResults(message.ticket, message.average)
            }
            break
            
        case 'votesReset':
            if (state.session) {
                const ticket = state.session.tickets.find(t => t.id === message.ticketId)
                if (ticket) {
                    ticket.votes = {}
                }
                state.session.votingRevealed = false
                state.myVote = null
                state.votedCount = 0
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
    if (!listEl || !state.session) return
    
    listEl.innerHTML = state.session.users.map(user => {
        const hasVoted = state.session?.selectedTicketId 
            ? state.session.tickets.find(t => t.id === state.session?.selectedTicketId)?.votes[user.id] !== undefined
            : false
        const voteIndicator = user.role === 'player' 
            ? (hasVoted || (state.session?.votingRevealed && state.myVote && user.id === state.userId) ? '✅' : '⏳')
            : ''
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
    
    if (state.session.tickets.length === 0) {
        const isObserver = isCurrentObserver()
        const message = isObserver
            ? 'No tickets yet. Add one to get started!'
            : 'No tickets yet. Please wait for the observer to add tickets.'

        listEl.innerHTML = `<li class="empty-state">${message}</li>`
        return
    }
    
    listEl.innerHTML = state.session.tickets.map(ticket => `
        <li class="${ticket.id === state.session?.selectedTicketId ? 'selected' : ''}" 
            data-ticket-id="${ticket.id}">
            <div class="ticket-title">${escapeHtml(ticket.title)}</div>
            ${ticket.description ? `<div class="ticket-desc">${escapeHtml(ticket.description)}</div>` : ''}
        </li>
    `).join('')
    
    // Add click handlers
    const isObserver = isCurrentObserver()
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
                ${!isPlayer ? 'disabled' : ''}>
            ${points}
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

function showResults(ticket: Ticket, average: number): void {
    const resultsSection = getElement<HTMLDivElement>('results-section')
    const votesDisplay = getElement<HTMLDivElement>('votes-display')
    const averageDisplay = getElement<HTMLDivElement>('average-display')
    
    if (!resultsSection || !votesDisplay || !averageDisplay || !state.session) return
    
    resultsSection.classList.remove('hidden')
    
    votesDisplay.innerHTML = Object.entries(ticket.votes).map(([oderId, vote]) => {
        const user = state.session?.users.find(u => u.id === oderId)
        return `
            <div class="vote-item">
                <div class="voter-name">${escapeHtml(user?.name || 'Unknown')}</div>
                <div class="vote-value">${vote ?? '-'}</div>
            </div>
        `
    }).join('')
    
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
        localStorage.removeItem('ponypoker_teamCode')
        state.session = null
        state.userId = null
        state.ws?.close()
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
