

WatchParty — Social & Collaborative Viewing Platform
S26CS6.401 — Software Engineering  |  Project 3 Proposal  |  Domain: Entertainment (OTT)
## 1. Use Case
Distributed friend groups and couples want to watch online video together but existing workarounds (screen-sharing, browser extensions)
suffer from sync drift and no integrated social layer. WatchParty provides a purpose-built co-viewing room — joinable via a browser link with
no install — offering synchronised playback and a collaborative queue.
Target users: Friend groups, long-distance couples, fan communities.  Prototype scope: ≤10 users/room. Voice/video communication,
post-session analytics, and OTT catalogue integrations are explicitly out of scope.
## 2. Functional Requirements
Priority legend:  Must Have = prototype blocker  |  Should Have = high value, target for prototype  |  Could Have = stretch goal
PriorityRequirementDescription
## Must Have
FR-01 Room Creation
Any user can create a watch room and receive a shareable invite link; no account required to join
as a guest.
## Must Have
FR-02 Playback Sync
Play, pause, and seek commands from the host are broadcast to all guests; players mirror host
state within ~1 s.
## Must Have
FR-03 Late-Join
Catch-Up
A client joining mid-session automatically fast-forwards to the current playback position.
## Must Have
FR-04 Host / Guest
## Roles
Creator becomes host with full playback control; guests have view-only access unless granted
co-host rights.
## Should Have
FR-05 Vote-to-Watch
## Queue
Members nominate video URLs; entries ranked by upvote count; top entry plays next
automatically.
## Should Have
FR-06 Skip VoteMajority-vote skip mechanic lets the group move past the current video without host intervention.
## Should Have
FR-07 Host MigrationIf the host disconnects, the server promotes the longest-connected guest to host within 3 s.
## Could Have
FR-08 Guest Display
## Names
Guests set a display name for the session without creating a full account.
## Could Have
FR-09 Persistent Room
## History
Room watch history and queue persist across sessions so members can resume later.
## Could Have
FR-10 Live Chat
Room members can send real-time text messages and emoji reactions visible to all participants
during playback.
- Non-Functional Requirements
IDAttributeRequirementRationale
NFR-01Sync LatencyPlayback state propagates to all guests within 1 s on
broadband.
Drift > 1 s breaks the shared-viewing illusion.
NFR-02AvailabilityServer targets 99% uptime during evaluation; planned
downtime announced in advance.
Mid-session outages ruin the experience.
NFR-03Fault
## Tolerance
Host dropout triggers automatic promotion of a guest
within 3 s; session continues uninterrupted.
One user's issue shouldn't terminate the room for
everyone.
NFR-04ScalabilitySupports ≤10 users/room and ≤20 simultaneous rooms
without performance degradation.
Matches realistic small-group use; larger scale is
deferred.
NFR-05UsabilityA first-time user can create a room and invite a friend
within 2 minutes; no account or install needed.
Onboarding friction is the primary abandonment
point for social tools.

IDAttributeRequirementRationale
NFR-06SecurityRooms accessible only via invite link; tokens expire after
24 hours of inactivity.
Prevents uninvited guests from joining private
sessions.
NFR-07Browser
## Compat.
Core features work on the latest two stable versions of
Chrome, Firefox, and Safari.
Users should not need to switch browsers or install
plugins.
NFR-08MaintainabilityAgreed coding standards enforced; each module has
≥70% unit-test coverage before integration.
Supports parallel development and reduces
regression risk.
## 4. Architecture & Design
## Web Client
Browser (Host)
## Web Client
Browser (Guest)
Real-time sync (WebSocket)
API Gateway
## Auth · Rate-limit · Route
## Sync Service
## Playback · Catch-up
## Room Service
## Roles · Queue · Invite
## State Store
Playback snapshots
## Database
## Rooms · Users · Queue
Client / ServiceData storeGateway
## Design Patterns
Observer / Pub-Sub: Playback and state events broadcast from
server to all room clients.
State Machine: Room lifecycle (Waiting → Active → Paused →
Ended) prevents invalid transitions.
Command: Play/Pause/Seek are discrete objects — easy to validate,
log, and replay for late-join catch-up.
Host-Authoritative: Single source of truth eliminates distributed
consensus complexity.
## 5. Domain
Entertainment — OTT / Social Viewing. Core engineering challenges
(real-time state sync, event broadcasting, conflict resolution in a
distributed client model) transfer directly to virtual classrooms and
collaborative tools, giving the project both academic depth and
practical relevance.
- Prototype Timeline  (Team of 5, ~6 Weeks)
PhaseWhenKey Activities
## Research &
## Planning
Week 1Finalise sync model, wireframes,
API contracts, data schema
DesignWks 1–2System diagrams, UI mockups,
Room FSM, CI/CD setup
## Dev — Sync &
## Room
Wks 2–4Room create/join, host-auth
playback, role management,
reconnect handling
Dev — QueueWks 2–4Vote queue with upvote/skip
mechanics, room state
management
TestingWeek 5Integration tests, multi-browser
sync, usability study (5–8 users)
RefinementWeek 6Bug fixes, UI polish, demo prep and
documentation
Two prototype journeys in scope: (1) join a room and watch a video in
sync with host-controlled playback, and (2) nominate and vote on what
to watch next. Sync and Queue workstreams run in parallel (Weeks 2–4)
and integrate in Week 4.