/*
 * This file contains some shared functions. They are used by other modules, but
 * are defined here so that tests can import this library and test them.
 */

import * as Base64 from "crypto-js/enc-base64";
import HttpError from "./HttpError";
import { patientParams } from "./settings";
import { fhirclient } from "./types";
import SHA256 = require("crypto-js/sha256");
const debug = require("debug");

// $lab:coverage:off$
// @ts-ignore
const { fetch } = typeof FHIRCLIENT_PURE !== "undefined" ? window : require("cross-fetch");
// $lab:coverage:on$

const _debug     = debug("FHIR");
export { _debug as debug };

/**
 * The cache for the `getAndCache` function
 */
const cache: fhirclient.JsonObject = {};

/**
 * A namespace with functions for converting between different measurement units
 */
export const units = {
    cm({ code, value }: fhirclient.CodeValue) {
        ensureNumerical({ code, value });
        if (code == "cm"     ) return value;
        if (code == "m"      ) return value *   100;
        if (code == "in"     ) return value *  2.54;
        if (code == "[in_us]") return value *  2.54;
        if (code == "[in_i]" ) return value *  2.54;
        if (code == "ft"     ) return value * 30.48;
        if (code == "[ft_us]") return value * 30.48;
        throw new Error("Unrecognized length unit: " + code);
    },
    kg({ code, value }: fhirclient.CodeValue){
        ensureNumerical({ code, value });
        if (code == "kg"    ) return value;
        if (code == "g"     ) return value / 1000;
        if (code.match(/lb/)) return value / 2.20462;
        if (code.match(/oz/)) return value / 35.274;
        throw new Error("Unrecognized weight unit: " + code);
    },
    any(pq: fhirclient.CodeValue){
        ensureNumerical(pq);
        return pq.value;
    }
};

/**
 * Assertion function to guard arguments for `units` functions
 */
function ensureNumerical({ value, code }: fhirclient.CodeValue) {
    if (typeof value !== "number") {
        throw new Error("Found a non-numerical unit: " + value + " " + code);
    }
}

/**
 * Used in fetch Promise chains to reject if the "ok" property is not true
 */
export async function checkResponse(resp: Response): Promise<Response> {
    if (!resp.ok) {
        const error = new HttpError(resp);
        await error.parse();
        throw error;
    }
    return resp;
}

/**
 * Used in fetch Promise chains to return the JSON version of the response.
 * Note that `resp.json()` will throw on empty body so we use resp.text()
 * instead.
 */
export function responseToJSON(resp: Response): Promise<object|string> {
    return resp.text().then(text => text.length ? JSON.parse(text) : "");
}

/**
 * This is our built-in request function. It does a few things by default
 * (unless told otherwise):
 * - Makes CORS requests
 * - Sets accept header to "application/json"
 * - Handles errors
 * - If the response is json return the json object
 * - If the response is text return the result text
 * - Otherwise return the response object on which we call stuff like `.blob()`
 */
export function request<T = fhirclient.FetchResult>(
    url: string | Request,
    requestOptions: fhirclient.FetchOptions = {}
): Promise<T>
{
    const { includeResponse, ...options } = requestOptions;
    return fetch(url, {
        mode: "cors",
        ...options,
        headers: {
            accept: "application/json",
            ...options.headers
        }
    })
    .then(checkResponse)
    .then((res: Response) => {
        const type = res.headers.get("Content-Type") + "";
        if (type.match(/\bjson\b/i)) {
            return responseToJSON(res).then(body => ({ res, body }));
        }
        if (type.match(/^text\//i)) {
            return res.text().then(body => ({ res, body }));
        }
        return { res };
    })
    .then(({res, body}: {res:Response, body?:fhirclient.JsonObject|string}) => {

        // Some servers will reply after CREATE with json content type but with
        // empty body. In this case check if a location header is received and
        // fetch that to use it as the final result.
        if (!body && res.status == 201) {
            const location = res.headers.get("location") + "";
            if (location) {
                return request(location, { ...options, method: "GET", body: null, includeResponse });
            }
        }

        if (includeResponse) {
            return { body, response: res };
        }

        // For any non-text and non-json response return the Response object.
        // This to let users decide if they want to call text(), blob() or
        // something else on it
        if (body === undefined) {
            return res;
        }

        // Otherwise just return the parsed body (can also be "" or null)
        return body;
    });
}

/**
 * Makes a request using `fetch` and stores the result in internal memory cache.
 * The cache is cleared when the page is unloaded.
 * @param url The URL to request
 * @param requestOptions Request options
 * @param force If true, reload from source and update the cache, even if it has
 * already been cached.
 */
export function getAndCache(url: string, requestOptions?: RequestInit, force: boolean = process.env.NODE_ENV === "test"): Promise<any> {
    if (force || !cache[url]) {
        cache[url] = request(url, requestOptions);
        return cache[url];
    }
    return Promise.resolve(cache[url]);
}

/**
 * Fetches the conformance statement from the given base URL.
 * Note that the result is cached in memory (until the page is reloaded in the
 * browser) because it might have to be re-used by the client
 * @param baseUrl The base URL of the FHIR server
 * @param [requestOptions] Any options passed to the fetch call
 */
export function fetchConformanceStatement(baseUrl = "/", requestOptions?: RequestInit): Promise<fhirclient.FHIR.CapabilityStatement>
{
    const url = String(baseUrl).replace(/\/*$/, "/") + "metadata";
    return getAndCache(url, requestOptions).catch((ex: Error) => {
        throw new Error(
            `Failed to fetch the conformance statement from "${url}". ${ex}`
        );
    });
}


/**
 * Walks through an object (or array) and returns the value found at the
 * provided path. This function is very simple so it intentionally does not
 * support any argument polymorphism, meaning that the path can only be a
 * dot-separated string. If the path is invalid returns undefined.
 * @param obj The object (or Array) to walk through
 * @param path The path (eg. "a.b.4.c")
 * @returns {*} Whatever is found in the path or undefined
 */
export function getPath(obj: fhirclient.JsonObject, path = ""): any {
    path = path.trim();
    if (!path) {
        return obj;
    }

    let segments = path.split(".");
    let result = obj;

    while (result && segments.length) {
        const key = segments.shift();
        if (!key && Array.isArray(result)) {
            return result.map(o => getPath(o, segments.join(".")));
        } else {
            result = result[key as string];
        }
    }

    return result;
}

/**
 * Like getPath, but if the node is found, its value is set to @value
 * @param obj The object (or Array) to walk through
 * @param path The path (eg. "a.b.4.c")
 * @param value The value to set
 * @param createEmpty If true, create missing intermediate objects or arrays
 * @returns The modified object
 */
export function setPath(obj: fhirclient.JsonObject, path: string, value: any, createEmpty = false): fhirclient.JsonObject {
    path.trim().split(".").reduce(
        (out, key, idx, arr) => {
            if (out && idx === arr.length - 1) {
                out[key] = value;
            }
            else {
                if (out && out[key] === undefined && createEmpty) {
                    out[key] = arr[idx + 1].match(/^[0-9]+$/) ? [] : {};
                }
                return out ? out[key] : undefined;
            }
        },
        obj
    );
    return obj;
}

/**
 * If the argument is an array returns it as is. Otherwise puts it in an array
 * (`[arg]`) and returns the result
 * @param arg The element to test and possibly convert to array
 * @category Utility
 */
export function makeArray<T = any>(arg: any): T[] {
    if (Array.isArray(arg)) {
        return arg;
    }
    return [arg];
}

/**
 * Given a path, converts it to absolute url based on the `baseUrl`. If baseUrl
 * is not provided, the result would be a rooted path (one that starts with `/`).
 * @param path The path to convert
 * @param baseUrl The base URL
 */
export function absolute(path: string, baseUrl?: string): string
{
    if (path.match(/^http/)) return path;
    if (path.match(/^urn/)) return path;
    return String(baseUrl || "").replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/**
 * Generates random strings. By default this returns random 8 characters long
 * alphanumeric strings.
 * @param strLength The length of the output string. Defaults to 8.
 * @param charSet A string containing all the possible characters.
 *     Defaults to all the upper and lower-case letters plus digits.
 * @category Utility
 */
export function randomString(
    strLength = 8,
    charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
): string
{
    const result = [];
    const len = charSet.length;
    while (strLength--) {
        result.push(charSet.charAt(Math.floor(Math.random() * len)));
    }
    return result.join("");
}

/**
 * Generate a PKCE challenge pair with verifier length to 43
 * @category Utility
 */
export function createPKCEChallenge(): fhirclient.PKCEObject {

    const charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const verifier = randomString(43, charSet);
    const challenge = Base64.stringify(SHA256(verifier))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

    return {
        code_verifier: verifier,
        code_challenge: challenge,
    };
}

/**
 * Decodes a JWT token and returns its body.
 * @param token The token to read
 * @param env An `Adapter` or any other object that has an `atob` method
 * @category Utility
 */
export function jwtDecode(token: string, env: fhirclient.Adapter): fhirclient.JsonObject | null
{
    const payload = token.split(".")[1];
    return payload ? JSON.parse(env.atob(payload)) : null;
}

/**
 * Given a token response, computes and returns the expiresAt timestamp.
 * Note that this should only be used immediately after an access token is
 * received, otherwise the computed timestamp will be incorrect.
 * @param tokenResponse 
 * @param env 
 */
export function getAccessTokenExpiration(tokenResponse: fhirclient.TokenResponse, env: fhirclient.Adapter): number
{
    const now = Math.floor(Date.now() / 1000);

    // Option 1 - using the expires_in property of the token response
    if (tokenResponse.expires_in) {
        return now + tokenResponse.expires_in;
    }

    // Option 2 - using the exp property of JWT tokens (must not assume JWT!)
    if (tokenResponse.access_token) {
        let tokenBody = jwtDecode(tokenResponse.access_token, env);
        if (tokenBody && tokenBody.exp) {
            return tokenBody.exp;
        }
    }

    // Option 3 - if none of the above worked set this to 5 minutes after now
    return now + 300;
}

/**
 * Groups the observations by code. Returns a map that will look like:
 * ```js
 * const map = client.byCodes(observations, "code");
 * // map = {
 * //     "55284-4": [ observation1, observation2 ],
 * //     "6082-2": [ observation3 ]
 * // }
 * ```
 * @param observations Array of observations
 * @param property The name of a CodeableConcept property to group by
 */
export function byCode(
    observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[],
    property: string
): fhirclient.ObservationMap
{
    const ret: fhirclient.ObservationMap = {};

    function handleCodeableConcept(concept: fhirclient.FHIR.CodeableConcept, observation: fhirclient.FHIR.Observation) {
        if (concept && Array.isArray(concept.coding)) {
            concept.coding.forEach(({ code }) => {
                if (code) {
                    ret[code] = ret[code] || [] as fhirclient.FHIR.Observation[];
                    ret[code].push(observation);
                }
            });
        }
    }

    makeArray(observations).forEach(o => {
        if (o.resourceType === "Observation" && o[property]) {
            if (Array.isArray(o[property])) {
                o[property].forEach((concept: fhirclient.FHIR.CodeableConcept) => handleCodeableConcept(concept, o));
            } else {
                handleCodeableConcept(o[property], o);
            }
        }
    });

    return ret;
}

/**
 * First groups the observations by code using `byCode`. Then returns a function
 * that accepts codes as arguments and will return a flat array of observations
 * having that codes. Example:
 * ```js
 * const filter = client.byCodes(observations, "category");
 * filter("laboratory") // => [ observation1, observation2 ]
 * filter("vital-signs") // => [ observation3 ]
 * filter("laboratory", "vital-signs") // => [ observation1, observation2, observation3 ]
 * ```
 * @param observations Array of observations
 * @param property The name of a CodeableConcept property to group by
 */
export function byCodes(
    observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[],
    property: string
): (...codes: string[]) => any[]
{
    const bank = byCode(observations, property);
    return (...codes) => codes
        .filter(code => (code + "") in bank)
        .reduce(
            (prev, code) => prev.concat(bank[code + ""]),
            [] as fhirclient.FHIR.Observation[]
        );
}

/**
 * Given a conformance statement and a resource type, returns the name of the
 * URL parameter that can be used to scope the resource type by patient ID.
 */
export function getPatientParam(conformance: fhirclient.FHIR.CapabilityStatement, resourceType: string): string
{
    // Find what resources are supported by this server
    const resources = getPath(conformance, "rest.0.resource") || [];

    // Check if this resource is supported
    const meta = resources.find((r: any) => r.type === resourceType);
    if (!meta) {
        throw new Error(`Resource "${resourceType}" is not supported by this FHIR server`);
    }

    // Check if any search parameters are available for this resource
    if (!Array.isArray(meta.searchParam)) {
        throw new Error(`No search parameters supported for "${resourceType}" on this FHIR server`);
    }

    // This is a rare case but could happen in generic workflows
    if (resourceType == "Patient" && meta.searchParam.find((x: any) => x.name == "_id")) {
        return "_id";
    }

    // Now find the first possible parameter name
    const out = patientParams.find(p => meta.searchParam.find((x: any) => x.name == p));

    // If there is no match
    if (!out) {
        throw new Error("I don't know what param to use for " + resourceType);
    }

    return out;
}

/**
 * Resolves a reference to target window. It may also open new window or tab if
 * the `target = "popup"` or `target = "_blank"`.
 * @param target
 * @param width Only used when `target = "popup"`
 * @param height Only used when `target = "popup"`
 */
export async function getTargetWindow(target: fhirclient.WindowTarget, width: number = 800, height: number = 720): Promise<Window>
{
    // The target can be a function that returns the target. This can be
    // used to open a layer pop-up with an iframe and then return a reference
    // to that iframe (or its name)
    if (typeof target == "function") {
        target = await target();
    }

    // The target can be a window reference
    if (target && typeof target == "object") {
        return target;
    }

    // At this point target must be a string
    if (typeof target != "string") {
        _debug("Invalid target type '%s'. Failing back to '_self'.", typeof target);
        return self;
    }

    // Current window
    if (target == "_self") {
        return self;
    }

    // The parent frame
    if (target == "_parent") {
        return parent;
    }

    // The top window
    if (target == "_top") {
        return top;
    }

    // New tab or window
    if (target == "_blank") {
        let error, targetWindow: Window | null = null;
        try {
            targetWindow = window.open("", "SMARTAuthPopup");
            if (!targetWindow) {
                throw new Error("Perhaps window.open was blocked");
            }
        } catch (e) {
            error = e;
        }

        if (!targetWindow) {
            _debug("Cannot open window. Failing back to '_self'. %s", error);
            return self;
        } else {
            return targetWindow;
        }
    }

    // Popup window
    if (target == "popup") {
        let error, targetWindow: Window | null = null;
        // if (!targetWindow || targetWindow.closed) {
        try {
            targetWindow = window.open("", "SMARTAuthPopup", [
                "height=" + height,
                "width=" + width,
                "menubar=0",
                "resizable=1",
                "status=0",
                "top=" + (screen.height - height) / 2,
                "left=" + (screen.width - width) / 2
            ].join(","));
            if (!targetWindow) {
                throw new Error("Perhaps the popup window was blocked");
            }
        } catch (e) {
            error = e;
        }

        if (!targetWindow) {
            _debug("Cannot open window. Failing back to '_self'. %s", error);
            return self;
        } else {
            return targetWindow;
        }
    }

    // Frame or window by name
    const winOrFrame: Window = frames[target as any];
    if (winOrFrame) {
        return winOrFrame;
    }

    _debug("Unknown target '%s'. Failing back to '_self'.", target);
    return self;
}
