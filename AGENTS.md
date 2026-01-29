# Never Pony Poker
A poker app used to add story points to tickets by a Scrum team

## Technology platform

### Backend
- Node.js
- All server code is written in Typescript. Explicitly specify types wherever possible.
- Express library for web UI and APIs
- Websocket


### Frontend
- Vanilla JavaScript over frontend frameworks
- Html 5
- Use browser native features whenever possible. Supporting latest Chrome and iOS Safari browsers is sufficient.
- Client code is written using typescript. Explicitly specify types wherever possible.

#### Development
**Backend**
- To run, `npm run dev:backend`

**Frontend**
- Parcel as build tool
- To run, `npm run dev:frontend`. 

### Build and run
1. npm ci
2. npm run build
3. npm start

## How to push to Azure
```
az acr build --registry nppacr --image neverponiespoker:v1.6 .
```