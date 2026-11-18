
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        success: true,
        message: "Talanta Tickets Production Worker is running"
      });
    }

    // M-Pesa STK Push
    if (url.pathname === "/api/mpesa/stkpush" && request.method === "POST") {
      try {
        const { phone, amount } = await request.json();

        const normalizedPhone = String(phone || "").replace(/\D/g, "");
        const paymentAmount = Number(amount);

        if (
          !/^254[17]\d{8}$/.test(normalizedPhone) ||
          !Number.isSafeInteger(paymentAmount) ||
          paymentAmount < 1
        ) {
          return Response.json(
            { success: false, message: "Enter a valid Kenyan phone number and whole-number amount." },
            { status: 400 }
          );
        }

        if (
          !env.MPESA_CONSUMER_KEY ||
          !env.MPESA_CONSUMER_SECRET ||
          !env.MPESA_SHORTCODE ||
          !env.MPESA_PASSKEY ||
          !env.MPESA_CALLBACK_URL ||
          !env.DB
        ) {
          return Response.json(
            { success: false, message: "Payment service is not fully configured." },
            { status: 500 }
          );
        }

        // Get production access token
        const credentials = btoa(
          `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
        );

        const tokenResponse = await fetch(
          "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
          {
            headers: {
              Authorization: `Basic ${credentials}`
            }
          }
        );

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok || !tokenData.access_token) {
          return Response.json(
            { success: false, message: "Could not authenticate with Safaricom." },
            { status: 502 }
          );
        }

        // Generate timestamp and password
        const timestamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);

        const password = btoa(
          `${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`
        );

        // Send production STK Push
        const stkResponse = await fetch(
          "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              BusinessShortCode: env.MPESA_SHORTCODE,
              Password: password,
              Timestamp: timestamp,
              TransactionType: "CustomerBuyGoodsOnline",
              Amount: paymentAmount,
              PartyA: normalizedPhone,
              PartyB: env.MPESA_SHORTCODE,
              PhoneNumber: normalizedPhone,
              CallBackURL: env.MPESA_CALLBACK_URL,
              AccountReference: "TalantaTickets",
              TransactionDesc: "Ticket Payment"
            })
          }
        );

        const result = await stkResponse.json();

        if (!stkResponse.ok || result.ResponseCode !== "0") {
          return Response.json(
            {
              success: false,
              message: "Safaricom did not accept the STK Push request.",
              result
            },
            { status: 502 }
          );
        }

        if (result.CheckoutRequestID) {
          await env.DB.prepare(
            `INSERT INTO payments
             (phone, amount, checkout_request_id, status)
             VALUES (?, ?, ?, ?)`
          ).bind(
            normalizedPhone,
            paymentAmount,
            result.CheckoutRequestID,
            "PENDING"
          ).run();
        }

        return Response.json({
          success: true,
          message: "STK Push request accepted. Check your phone.",
          checkoutRequestId: result.CheckoutRequestID,
          merchantRequestId: result.MerchantRequestID
        });

      } catch (error) {
        return Response.json(
          { success: false, message: "Payment request failed." },
          { status: 500 }
        );
      }
    }

    // Safaricom callback
    if (url.pathname === "/api/mpesa/callback" && request.method === "POST") {
      try {
        const callback = await request.json();
        const data = callback.Body?.stkCallback;

        if (!data?.CheckoutRequestID) {
          return Response.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
          });
        }

        const success = data.ResultCode === 0;
        const metadata = data.CallbackMetadata?.Item || [];

        const receipt = metadata.find(
          item => item.Name === "MpesaReceiptNumber"
        )?.Value || null;

        await env.DB.prepare(
          `UPDATE payments
           SET status = ?, receipt_number = ?
           WHERE checkout_request_id = ?`
        ).bind(
          success ? "PAID" : "FAILED",
          receipt,
          data.CheckoutRequestID
        ).run();

        return Response.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });

      } catch (error) {
        return Response.json(
          { ResultCode: 1, ResultDesc: "Callback processing failed" },
          { status: 500 }
        );
      }
    }

    return Response.json(
      { success: false, message: "Not found" },
      { status: 404 }
    );
  }
};
