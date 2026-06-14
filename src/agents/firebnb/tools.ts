import type { ToolDef } from "../../types.js";

interface SearchRatesInput {
  destination_query: string;
  check_in?: string;
  check_out?: string;
  occupancy?: {
    rooms: Array<{
      adults: number;
      child_ages?: number[];
    }>;
  };
  filters?: {
    star_min?: number;
    price_max?: number;
    price_currency?: string;
    amenities?: string[];
    free_cancellation?: boolean;
    near?: string;
  };
}

export const searchRatesTool: ToolDef<SearchRatesInput> = {
  name: "search_rates",
  description:
    "Queries live or cached hotel rates for a destination from FireBNB. ALWAYS call this tool first before offering hotel prices or recommendations. If check_in and check_out dates are omitted, defaults to 7 and 8 days from today respectively.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      destination_query: {
        type: "string",
        description: "The location, neighborhood, or hotel name the user is searching for, e.g. 'Calangute, Goa' or 'Taj Palace Delhi'."
      },
      check_in: {
        type: "string",
        description: "Check-in date in YYYY-MM-DD format."
      },
      check_out: {
        type: "string",
        description: "Check-out date in YYYY-MM-DD format."
      },
      occupancy: {
        type: "object",
        description: "Room search occupancy. Defaults to 1 room with 2 adults.",
        properties: {
          rooms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                adults: { type: "number" },
                child_ages: {
                  type: "array",
                  items: { type: "number" }
                }
              },
              required: ["adults"],
              additionalProperties: false
            }
          }
        },
        required: ["rooms"],
        additionalProperties: false
      },
      filters: {
        type: "object",
        properties: {
          star_min: { type: "number" },
          price_max: { type: "number" },
          price_currency: { type: "string" },
          amenities: {
            type: "array",
            items: { type: "string" }
          },
          free_cancellation: { type: "boolean" },
          near: { type: "string" }
        },
        additionalProperties: false
      }
    },
    required: ["destination_query"],
    additionalProperties: false
  },
  run: async (input) => {
    const functionsUrl = process.env.FIREBNB_FUNCTIONS_URL || "http://127.0.0.1:54321/functions/v1";
    const serviceToken = process.env.JANTRA_FIREBNB_SERVICE_TOKEN || "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (serviceToken) {
      headers["X-Service-Auth"] = serviceToken;
    }

    // 1. Resolve destination via places-autocomplete
    let place;
    try {
      const autocompleteUrl = `${functionsUrl}/places-autocomplete?q=${encodeURIComponent(input.destination_query)}`;
      const res = await fetch(autocompleteUrl, { method: "GET", headers });
      if (!res.ok) {
        const text = await res.text();
        return { content: `Error from places-autocomplete (status ${res.status}): ${text}`, isError: true };
      }
      const json = (await res.json()) as any;
      const places = json.data?.places || [];
      if (places.length === 0) {
        return { content: `Could not resolve destination "${input.destination_query}". Please ask the user to clarify.` };
      }
      place = places[0];
    } catch (err) {
      return { content: `Failed to resolve destination: ${String(err)}`, isError: true };
    }

    // 2. Call rates-search with resolved place
    const getOffsetDate = (offsetDays: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      return d.toISOString().split("T")[0];
    };

    const checkIn = input.check_in || getOffsetDate(7);
    const checkOut = input.check_out || getOffsetDate(8);
    const occupancy = input.occupancy || { rooms: [{ adults: 2, child_ages: [] }] };
    const filters = input.filters || {
      star_min: null,
      price_max: null,
      price_currency: "INR",
      amenities: [],
      free_cancellation: null,
      near: null
    };

    try {
      const ratesUrl = `${functionsUrl}/rates-search`;
      const ratesRes = await fetch(ratesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          destination_id: place.id,
          destination_kind: place.kind,
          check_in: checkIn,
          check_out: checkOut,
          occupancy,
          filters
        })
      });

      if (!ratesRes.ok) {
        const text = await ratesRes.text();
        return { content: `Error from rates-search (status ${ratesRes.status}): ${text}`, isError: true };
      }

      const ratesJson = (await ratesRes.json()) as any;
      const data = ratesJson.data || {};
      const target = data.target;
      const alternatives = data.alternatives || [];

      let out = `Resolved destination: **${place.name}** (${place.kind === "hotel" ? "Hotel" : "City"})\n`;
      out += `Dates: ${checkIn} to ${checkOut}\n\n`;

      if (target) {
        out += `### Target Hotel:\n`;
        out += `- **${target.hotel.name}** (${target.hotel.star_class}-star)\n`;
        out += `  - Market Average Rate (MAR): ₹${target.mar}\n`;
        out += `  - Typical High Rate: ₹${target.highest_source_rate}\n`;
        out += `  - Discount percentage relative to top: ${target.pct_below_top}%\n\n`;
      }

      if (alternatives.length > 0) {
        out += `### Available Options / Alternatives:\n`;
        out += `| Hotel Name | Stars | Market Avg Rate (MAR) | Typical High | Discount |\n`;
        out += `| --- | --- | --- | --- | --- |\n`;
        for (const alt of alternatives) {
          out += `| ${alt.hotel.name} | ${alt.hotel.star_class}★ | ₹${alt.mar} | ₹${alt.highest_source_rate} | ${alt.pct_below_top}% |\n`;
        }
      } else {
        out += `No alternative hotel deals found for these filters/dates.\n`;
      }

      return { content: out };
    } catch (err) {
      return { content: `Failed to search rates: ${String(err)}`, isError: true };
    }
  }
};

export const finishConversationTool: ToolDef = {
  name: "finish_conversation",
  description: "Call this tool to end the conversation when the user says goodbye or when all their questions have been answered.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  run: () => ({ content: "CONVERSATION_FINISHED" }),
};
