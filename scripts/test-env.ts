// Tests never call hosted models with the developer's keys; the act tool is tested
// with a scripted Jev, and the live bench runs outside `bun test`.
delete process.env.JEV_API_KEY;
delete process.env.TYPESAFE_API_KEY;
