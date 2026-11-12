import { expect, test } from "bun:test";
import { siteOf } from "./network.ts";

test("siteOf groups a site's subdomains and keeps country-code second levels", () => {
  expect(siteOf("https://mail.google.com/mail/u/0/")).toBe("google.com");
  expect(siteOf("https://signaler-pa.clients6.google.com/x")).toBe("google.com");
  expect(siteOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  expect(siteOf("https://www.amazon.in/s")).toBe("amazon.in");
  expect(siteOf("http://127.0.0.1:8080/page")).toBe("127.0.0.1");
  expect(siteOf("about:blank")).toBeUndefined();
});
