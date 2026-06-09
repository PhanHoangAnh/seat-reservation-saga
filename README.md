# Seat Reservation Saga System

A distributed microservices implementation demonstrating the **Saga Orchestration Pattern** to manage data consistency across independent services.


## System Summary
This system provides a robust mechanism to reserve seats and process payments without utilizing distributed (XA) transactions, which are inefficient in microservice environments. We use an **Orchestration-based Saga** where the `api-gateway` coordinates the transaction state and manages compensation logic.

---

## Architecture: Why Microservices?
You might ask: *Why not build this as a Monolith?*

While a Monolithic architecture is easier to develop, it creates a "Single Point of Failure" and limits your ability to scale. We chose Microservices for this system for three specific reasons:

1.  **Independent Scalability:** During a high-traffic event (e.g., concert ticket sales), the `reservation-service` experiences massive load. In a monolith, we would have to scale the *entire* application. With microservices, we can spin up 50 instances of the `reservation-service` while leaving the `payment` and `auth` services at minimal scale.
2.  **Fault Isolation:** If the `payment-service` encounters a bug or memory leak, the `reservation-service` remains fully operational. Users can still browse available seats while the payment team fixes their specific deployment.
3.  **Technology Heterogeneity:** This pattern allows the payment service to be written in a language optimized for financial security (e.g., Java or Go) while the reservation system remains in a high-concurrency Node.js/Fastify stack.

---

## Technical Challenges & Solutions

### The Difficulty
1.  **Distributed Consistency:** Each service has its own database. We cannot use `BEGIN TRANSACTION` across network boundaries.
2.  **Partial Failure:** If a user holds a seat but their payment is declined, the seat remains locked in the `reservation-service` forever, preventing other users from booking it.

### The Solution: Saga Orchestration
* **Centralized Orchestration:** The `api-gateway` acts as the Saga Manager, tracking the state of each transaction in a `saga_logs` database table.
* **Compensating Transactions:** For every "Action" (e.g., `HOLD_SEAT`), we define a "Compensating Action" (e.g., `RELEASE_SEAT`). If the saga enters a `FAILED` state, the orchestrator automatically triggers the compensating action to return the system to a clean state.

## Token Strategy & Authentication Lifecycle

Our system utilizes a tiered token strategy to balance security, user experience, and distributed transaction integrity.

| Token Type | Lifespan | Type | Purpose | Storage |
| :--- | :--- | :--- | :--- | :--- |
| **Access Token** | 15 Minutes | JWT | Grants access to API routes. | In-memory (Client) |
| **Refresh Token** | 90 Days | Opaque String | Exchanges for new Access Tokens. | `sessions` table (Postgres) |
| **Saga Trans. ID**| Duration of Saga | Numeric ID | Tracks state of booking flow. | `saga_logs` table (Postgres) |

### Explanation of Tiers

1. **Access Token (Short-Lived):**
   - **Mechanism:** A JWS (JSON Web Signature) containing user claims.
   - **Why:** Stateless validation at the Gateway. The gateway verifies the signature using the `JWT_SECRET` without hitting the database, reducing latency.
   - **Security:** Limited exposure window; if stolen, it expires quickly.

2. **Refresh Token (Long-Lived):**
   - **Mechanism:** High-entropy random string stored as a hash in the database.
   - **Why:** Allows users to stay logged in over weeks.
   - **Revocation:** Since we store these in a database table, we can revoke access instantly (by updating `revoked_at` in the `sessions` table) if a device is reported lost or a user logs out.

3. **Saga Transaction ID (Temporary):**
   - **Mechanism:** A database-generated primary key in `saga_logs`.
   - **Why:** Unlike Auth tokens, this is *business state*. It binds the distributed steps (Hold $\rightarrow$ Payment $\rightarrow$ Reserve) together. It is the "source of truth" used by the `api-gateway` to track where a transaction stands if a service crashes.

---

## Front-end Behavior
The `web-client` is a Single Page Application (SPA) designed to test the Saga flow. Its behavior is as follows:

1.  **Authentication Lifecycle:** Upon login, the client sends credentials to the `auth-service`. On success, it receives a JWT which is held in memory.
2.  **State Management:** The dashboard uses the JWT for every request. It hides/shows DOM elements based on authentication status.
3.  **Asynchronous Orchestration:** When a user clicks a seat, the browser triggers a POST request to the Gateway. The UI displays "Processing..." while awaiting the orchestration result.
4.  **Feedback Loop:** The UI dynamically updates the status box (`green` for success, `red` for failure) based on the HTTP response from the Saga orchestrator, giving the user immediate feedback on the transaction status.

---
## Authentication vs. Booking State Management

In our booking system, we maintain two parallel "identities": who the user is (Authentication) and what the booking is doing (Saga State).

| Identifier | Context | Service Ownership | Booking Role |
| :--- | :--- | :--- | :--- |
| **Access Token (JWT)** | **User Identity** | Auth & Gateway | Validates "Who is making this booking?" |
| **Refresh Token** | **User Session** | Auth Service | Maintains login persistence. |
| **Saga Trans. ID** | **Booking Workflow** | Gateway & DB | Tracks "Where is this specific booking in the process?" |

### How they interact during a Booking

1. **Request Initiation (JWT Validation):**
   - When a user calls `POST /api/book`, the `api-gateway` validates the **Access Token** to confirm the `userId`. This ensures the request is authorized.
   - The Gateway then initializes the Saga by creating a **Saga Transaction ID** in `saga_logs`.

2. **Service Orchestration (Saga ID propagation):**
   - The Gateway acts as the conductor. It sends the **Saga Transaction ID** to the `reservation-service` and `payment-service`.
   - Even though these services don't need to know *who* the user is, they *must* know the `transactionId` to maintain the chain of command. If the payment fails, the Gateway uses that `transactionId` to tell the `reservation-service`: *"Roll back the seat hold associated with this specific ID."*

By keeping these separated, we ensure that the booking system can scale horizontally, as the services only need to track the `transactionId` without needing to store large user objects or session data.

3. **Consistency Guarantee:**
   - The **JWT** handles security (the "Do I trust this user?" question).
   - The **Saga Transaction ID** handles reliability (the "Do I know the state of this booking?" question).


---

## Deployment
Ensure you have Docker and Docker Compose installed.

```bash
# Build and deploy all services
docker compose up -d --build
```
The system will start:

-   **API Gateway:** `http://localhost:3000`
    
-   **Auth Service:** `http://localhost:3001`
    
-   **Reservation Service:** `http://localhost:3002`
    
-   **Payment Service:** `http://localhost:3003`


## Testing

### 1. Authenticate

Get your session token:
```bash
curl -X POST [http://127.0.0.1:3001/login](http://127.0.0.1:3001/login) \
  -H "Content-Type: application/json" \
  -d '{"email": "test@saga.test", "password": "securepassword123"}'
 ```
 ### 2. Success Flow
 ```bash
 # Request the booking
curl -X POST [http://127.0.0.1:3000/api/book](http://127.0.0.1:3000/api/book) \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"seatId": 1}'

# Trigger the Success Callback
curl -X POST [http://127.0.0.1:3000/api/payments/callback](http://127.0.0.1:3000/api/payments/callback) \
  -H "Content-Type: application/json" \
  -d '{"transactionId": <ID>, "status": "SUCCESS"}'
  ```

### 3. Failure (Compensation) Flow

Use `seatId: 999` to trigger the failure logic:
```
curl -X POST [http://127.0.0.1:3000/api/book](http://127.0.0.1:3000/api/book) \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"seatId": 999}'
  ```
  _Check the database to see the record updated to `FAILED` and `COMPENSATED`._
```
docker compose exec db psql -U saga_admin -d seat_reservation_system -c "SELECT * FROM public.saga_logs ORDER BY transaction_id DESC LIMIT 1;"
```

  
