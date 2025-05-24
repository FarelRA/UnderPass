# UnderPass

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FarelRA/underpass/tree/main)

**UnderPass** is an VLESS tunnel powered by Cloudflare Workers, allowing traffic to be securely proxied through the Cloudflare network. This solution is particularly useful for users who need reliable connectivity while bypassing restrictions.

## Features

- **Cloudflare Workers Integration** – Seamless deployment on Cloudflare's global edge network.
- **V2ray/Xray Client Support** – Optimized for use with the [V2ray-core](https://github.com/v2fly/v2ray-core) or [Xray-core](https://github.com/XTLS/Xray-core) tunnel client.
- **Secure and Configurable** – Easily customize the setup with Cloudflare Worker variables settings.
- **Global Availability** – Deployed and distributed across Cloudflare's network.

## Limitations

Due to Cloudflare Workers' constraints:
- **UDP proxying is not supported.**
- **Direct connections to Cloudflare IPs without proxy are restricted.**

## Usage of Variables

The configuration variables are defined in `wrangler.toml` and control how the tunnel operates. Below are detailed explanations of each variable:

### `USER_ID`

- **Purpose**: Used to authenticate with the V2Ray/Xray client.
- **Usage**: Instead of hardcoding it in `wrangler.toml`, store it securely in Cloudflare Secrets for better security.
- **Example Configuration in Secrets**:
  ```sh
  wrangler secret put USER_ID
  ```
  When prompted, enter the UUID securely.

### `PASSWORD`

- **Purpose**: Password used to protect `/info` path.
- **Usage**: Instead of hardcoding it in `wrangler.toml`, store it securely in Cloudflare Secrets for better security.
- **Example Configuration in Secrets**:
  ```sh
  wrangler secret put PASSWORD
  ```
  When prompted, enter the password securely.

### `PROXY_ADDR`

- **Purpose**: Specifies the proxy server address to connect to the Cloudflare Network.
- **Reason**: Cloudflare Workers prohibit direct socket connections to Cloudflare IPs, so a proxy is needed to relay traffic.
- **Example Configuration**:
  ```toml
  PROXY_ADDR = "gh.proxy.farel.is-a.dev:443"
  ```
  Change the value based on your proxy server’s address.

### `DOH_URL`

- **Purpose**: Determines the DNS-over-HTTPS url to use when resolving DNS queries..
- **Reason**: Cloudflare Workers not support UDP traffic, so when resolving DNS queries we used DOH.
- **Example Configuration**:
  ```toml
  DOH_URL = "https://1.1.1.1/dns-query"
  ```
  Replace it with your own DOH url.

### `LOG_LEVEL`

- **Purpose**: Controls the log level.
- **Reason**: This is particularly useful when debugging.
- **Example Configuration**:
  ```toml
  LOG_LEVEL = "INFO"
  ```
  Available log levels are ERROR, WARN, INFO, DEBUG.

## Installation & Deployment

### Prerequisites
- A **Cloudflare Workers account**.
- A **Cloudflare domain** (optional but recommended).
- A **correct variable configuration** setup.

To set up this project using Cloudflare Workers, follow these steps:

1. **Install Dependencies** (Choose one based on your package manager):

   ```sh
   npm init cloudflare my-project underpass
   # or
   yarn create cloudflare my-project underpass
   # or
   pnpm create cloudflare my-project underpass
   ```

2. **Modify Configuration**:

   - Update `wrangler.toml` with your custom values.
   - Store `USER_ID` and `PASSWORD` securely using Cloudflare Secrets.

3. **Deploy the Worker**:

   ```sh
   npm run deploy
   ```

## Troubleshooting & Issues

If you encounter any problems:
- Check Cloudflare Workers logs for debugging (`wrangler tail`).
- Verify your domain settings and routing configurations.
- Open an issue on the [`workerd`](https://github.com/cloudflare/workerd) or [`workers-sdk`](https://github.com/cloudflare/workers-sdk) repository for Worker-related issues.

## Documentation & Resources

- **Cloudflare Workers API**: [Official Docs](https://developers.cloudflare.com/workers/)
- **Workers Runtime APIs**: [Read More](https://developers.cloudflare.com/workers/runtime-apis/)
- **V2Ray/Xray Core**: [GitHub Repository](https://github.com/XTLS/Xray-core)

## Contributing

Contributions are welcome! Feel free to submit pull requests or report issues to improve the project.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
