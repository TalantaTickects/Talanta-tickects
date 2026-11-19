
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function normalizePhone(phone) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("0")) value = "254" + value.slice(1);
  if (value.startsWith("7") || value.startsWith("1")) {
    value = "254" + value;
  }

  return /^254[17]\d{8}$/.test(value) ? value : null;
}

function timestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return values.year + values.month + values.day +
    values.hour + values.minute + values.second;
}

// SAFARICOM LIVE OAUTH
async function getToken(env) {
  const credentials = btoa(
    env.MPESA_CONSUMER_KEY + ":" + env.MPESA_CONSUMER_SECRET
  );

  const response = await fetch(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + credentials
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Safaricom authentication failed");
  }

  return data.access_token;
}

function getPassword(env, time) {
  return btoa(
    env.MPESA_SHORTCODE + env.MPESA_PASSKEY + time
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({ success: true });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        message: "Talanta Tickets Worker is running"
      });
    }

    if (!env.DB) {
      return json({
        success: false,
        message: "Database is not connected."
      }, 500);
    }

    // CREATE BOOKING AND RESERVE SEATS
    if (url.pathname === "/api/bookings" && request.method === "POST") {
      try {
        const body = await request.json();

        const customerName = String(body.customerName || "").trim();
        const phone = normalizePhone(body.phone);
        const seats = body.seats;
        const ticketType = body.ticketType;

        if (!customerName || customerName.length > 100 || !phone) {
          return json({
            success: false,
            message: "Enter a valid name and Kenyan phone number."
          }, 400);
        }

        if (
          !Array.isArray(seats) ||
          seats.length < 1 ||
          seats.length > 32 ||
          !seats.every(s =>
            Number.isInteger(s) && s >= 1 && s <= 32
          ) ||
          new Set(seats).size !== seats.length
        ) {
          return json({
            success: false,
            message: "Please select valid seats."
          }, 400);
        }

        if (!["VIP", "Regular"].includes(ticketType)) {
          return json({
            success: false,
            message: "Invalid ticket category."
          }, 400);
        }

        const unavailable = [5, 12, 19, 26];

        if (seats.some(s => unavailable.includes(s))) {
          return json({
            success: false,
            message: "One or more selected seats are unavailable."
          }, 409);
        }

        const sortedSeats = [...seats].sort((a, b) => a - b);
        const price = ticketType === "VIP" ? 5000 : 2500;
        const amount = sortedSeats.length * price;
        const bookingId = crypto.randomUUID();

        const placeholders = sortedSeats.map(() => "?").join(",");

        const occupied = await env.DB.prepare(
          `SELECT seat_number FROM booking_seats
           WHERE active = 1 AND seat_number IN (${placeholders})`
        ).bind(...sortedSeats).all();

        if (occupied.results.length > 0) {
          return json({
            success: false,
            message: "Some seats have already been booked. Please choose other seats."
          }, 409);
        }

        const statements = [
          env.DB.prepare(
            `INSERT INTO bookings
             (id, customer_name, phone, seats, ticket_type, amount, status)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
          ).bind(
            bookingId,
            customerName,
            phone,
            JSON.stringify(sortedSeats),
            ticketType,
            amount
          )
        ];

        for (const seat of sortedSeats) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO booking_seats
               (booking_id, seat_number, active)
               VALUES (?, ?, 1)`
            ).bind(bookingId, seat)
          );
        }

        await env.DB.batch(statements);

        return json({
          success: true,
          bookingId,
          amount,
          message: "Booking saved. You can now request payment."
        });

      } catch (error) {
        return json({
          success: false,
          message: "Booking could not be saved. The seats may have just been taken."
        }, 409);
      }
    }

    // START M-PESA LIVE STK PUSH
    if (url.pathname === "/api/mpesa/stkpush" && request.method === "POST") {
      let paymentId = null;

      try {
        const body = await request.json();
        const bookingId = String(body.bookingId || "");

        if (!bookingId) {
          return json({
            success: false,
            message: "Booking reference is missing."
          }, 400);
        }

        if (
          !env.MPESA_CONSUMER_KEY ||
          !env.MPESA_CONSUMER_SECRET ||
          !env.MPESA_SHORTCODE ||
          !env.MPESA_TILL_NUMBER ||
          !env.MPESA_PASSKEY ||
          !env.MPESA_CALLBACK_URL
        ) {
          return json({
            success: false,
            message: "M-Pesa settings are incomplete."
          }, 500);
        }

        const booking = await env.DB.prepare(
          `SELECT id, phone, amount, status
           FROM bookings WHERE id = ?`
        ).bind(bookingId).first();

        if (!booking || booking.status !== "PENDING") {
          return json({
            success: false,
            message: "Booking not found or no longer payable."
          }, 404);
        }

        const previous = await env.DB.prepare(
          `SELECT id FROM payments
           WHERE booking_id = ?
           AND status = 'PENDING'
           AND checkout_request_id IS NOT NULL`
        ).bind(bookingId).first();

        if (previous) {
          return json({
            success: false,
            message: "A payment prompt has already been requested for this booking."
          }, 409);
        }

        paymentId = crypto.randomUUID();

        await env.DB.prepare(
          `INSERT INTO payments
           (id, booking_id, phone, amount, status)
           VALUES (?, ?, ?, ?, 'PENDING')`
        ).bind(
          paymentId,
          booking.id,
          booking.phone,
          booking.amount
        ).run();

        const token = await getToken(env);
        const time = timestamp();
        const password = getPassword(env, time);

        const stkResponse = await fetch(
          "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              BusinessShortCode: env.MPESA_SHORTCODE,
              Password: password,
              Timestamp: time,
              TransactionType: "CustomerBuyGoodsOnline",
              Amount: booking.amount,
              PartyA: booking.phone,
              PartyB: env.MPESA_TILL_NUMBER,
              PhoneNumber: booking.phone,
              CallBackURL: env.MPESA_CALLBACK_URL,
              AccountReference: "TALANTA",
              TransactionDesc: "TicketPayment"
            })
          }
        );

        const result = await stkResponse.json();

        if (
          !stkResponse.ok ||
          result.ResponseCode !== "0" ||
          !result.CheckoutRequestID
        ) {
          await env.DB.prepare(
            `UPDATE payments SET status = 'FAILED'
             WHERE id = ?`
          ).bind(paymentId).run();

          return json({
            success: false,
            message: "Safaricom did not accept the payment request."
          }, 502);
        }

        await env.DB.prepare(
          `UPDATE payments
           SET checkout_request_id = ?
           WHERE id = ?`
        ).bind(result.CheckoutRequestID, paymentId).run();

        return json({
          success: true,
          message: "M-Pesa prompt sent. Check your phone and enter your PIN.",
          bookingId,
          checkoutRequestId: result.CheckoutRequestID
        });

      } catch (error) {
        if (paymentId) {
          await env.DB.prepare(
            `UPDATE payments SET status = 'FAILED'
             WHERE id = ?`
          ).bind(paymentId).run().catch(() => {});
        }

        return json({
          success: false,
          message: "Payment request failed. Please contact support before trying again."
        }, 500);
      }
    }

    // CHECK BOOKING AND TICKETS
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/bookings/")
    ) {
      try {
        const bookingId = url.pathname.split("/").pop();

        const booking = await env.DB.prepare(
          `SELECT id, customer_name, amount, status
           FROM bookings WHERE id = ?`
        ).bind(bookingId).first();

        if (!booking) {
          return json({
            success: false,
            message: "Booking not found."
          }, 404);
        }

        const tickets = await env.DB.prepare(
          `SELECT seat_number, ticket_code
           FROM tickets WHERE booking_id = ?`
        ).bind(bookingId).all();

        return json({
          success: true,
          booking,
          tickets: tickets.results
        });

      } catch (error) {
        return json({
          success: false,
          message: "Could not check booking."
        }, 500);
      }
    }

    // SAFARICOM PAYMENT CALLBACK
    if (
      url.pathname === "/api/mpesa/callback" &&
      request.method === "POST"
    ) {
      try {
        const callback = await request.json();
        const data = callback.Body?.stkCallback;

        if (!data?.CheckoutRequestID) {
          return json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

        const payment = await env.DB.prepare(
          `SELECT id, booking_id, phone, amount, status
           FROM payments
           WHERE checkout_request_id = ?`
        ).bind(data.CheckoutRequestID).first();

        if (!payment || payment.status === "PAID") {
          return json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

        if (payment.status !== "PENDING") {
          return json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

        const booking = await env.DB.prepare(
          `SELECT id, phone, amount, status
           FROM bookings WHERE id = ?`
        ).bind(payment.booking_id).first();

        if (!booking || booking.status !== "PENDING") {
          return json({
            ResultCode: 1,
            ResultDesc: "Booking is not payable"
          }, 400);
        }

        // FAILED OR CANCELLED PAYMENT
        if (Number(data.ResultCode) !== 0) {
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE payments SET status = 'FAILED'
               WHERE id = ? AND status = 'PENDING'`
            ).bind(payment.id),

            env.DB.prepare(
              `UPDATE bookings SET status = 'FAILED'
               WHERE id = ? AND status = 'PENDING'`
            ).bind(payment.booking_id),

            env.DB.prepare(
              `UPDATE booking_seats SET active = 0
               WHERE booking_id = ?`
            ).bind(payment.booking_id)
          ]);

          return json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

        const items = data.CallbackMetadata?.Item || [];

        const getItem = name =>
          items.find(item => item.Name === name)?.Value;

        const receipt = getItem("MpesaReceiptNumber");
        const paidAmount = Number(getItem("Amount"));
        const paidPhone = normalizePhone(getItem("PhoneNumber"));

        // VERIFY PAYMENT AMOUNT AND PHONE
        if (
          !receipt ||
          !Number.isFinite(paidAmount) ||
          paidAmount !== Number(payment.amount) ||
          paidAmount !== Number(booking.amount) ||
          !paidPhone ||
          paidPhone !== payment.phone ||
          paidPhone !== booking.phone
        ) {
          return json({
            ResultCode: 1,
            ResultDesc: "Payment details could not be verified"
          }, 400);
        }

        // CHECK FOR DUPLICATE RECEIPT
        const duplicateReceipt = await env.DB.prepare(
          `SELECT id FROM payments
           WHERE mpesa_receipt = ? AND id != ?`
        ).bind(String(receipt), payment.id).first();

        if (duplicateReceipt) {
          return json({
            ResultCode: 1,
            ResultDesc: "Receipt already used"
          }, 400);
        }

        const seats = await env.DB.prepare(
          `SELECT seat_number FROM booking_seats
           WHERE booking_id = ? AND active = 1`
        ).bind(payment.booking_id).all();

        if (!seats.results.length) {
          return json({
            ResultCode: 1,
            ResultDesc: "No reserved seats found"
          }, 400);
        }

        const statements = [
          env.DB.prepare(
            `UPDATE payments
             SET status = 'PAID', mpesa_receipt = ?
             WHERE id = ? AND status = 'PENDING'`
          ).bind(String(receipt), payment.id),

          env.DB.prepare(
            `UPDATE bookings SET status = 'PAID'
             WHERE id = ? AND status = 'PENDING'`
          ).bind(payment.booking_id)
        ];

        for (const item of seats.results) {
          statements.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO tickets
               (id, booking_id, seat_number, ticket_code)
               VALUES (?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(),
              payment.booking_id,
              String(item.seat_number),
              crypto.randomUUID().replace(/-/g, "").toUpperCase()
            )
          );
        }

        await env.DB.batch(statements);

        return json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });

      } catch (error) {
        return json({
          ResultCode: 1,
          ResultDesc: "Callback processing failed"
        }, 500);
      }
    }

    return json({
      success: false,
      message: "Endpoint not found."
    }, 404);
  }
};
