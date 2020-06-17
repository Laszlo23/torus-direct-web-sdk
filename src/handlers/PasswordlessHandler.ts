import { BroadcastChannel } from "broadcast-channel";
import deepmerge from "deepmerge";
import jwtDecode from "jwt-decode";

import { LOGIN_TYPE } from "../utils/enums";
import { broadcastChannelOptions, getVerifierId, padUrlString } from "../utils/helpers";
import { get, post } from "../utils/httpHelpers";
import log from "../utils/loglevel";
import AbstractLoginHandler from "./AbstractLoginHandler";
import { Auth0ClientOptions, Auth0UserInfo, LoginWindowResponse, PopupResponse, TorusVerifierResponse } from "./interfaces";

export default class JwtHandler extends AbstractLoginHandler {
  private readonly SCOPE: string = "openid profile email";

  private readonly RESPONSE_TYPE: string = "token id_token";

  private readonly PROMPT: string = "login";

  constructor(
    readonly clientId: string,
    readonly verifier: string,
    readonly redirect_uri: string,
    readonly typeOfLogin: LOGIN_TYPE,
    readonly redirectToOpener?: boolean,
    readonly jwtParams?: Auth0ClientOptions
  ) {
    super(clientId, verifier, redirect_uri, redirectToOpener);
    this.setFinalUrl();
  }

  setFinalUrl(): void {
    const { domain } = this.jwtParams;
    const domainUrl = new URL(domain);
    domainUrl.pathname = "/passwordless/start";
    this.finalURL = domainUrl;
  }

  async getUserInfo(params: LoginWindowResponse): Promise<TorusVerifierResponse> {
    const { idToken, accessToken } = params;
    try {
      const { domain } = this.jwtParams;
      const domainUrl = new URL(domain);
      const userInfo = await get<Auth0UserInfo>(`${padUrlString(domainUrl)}userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const { picture, name, email } = userInfo;
      return {
        email,
        name,
        profileImage: picture,
        verifierId: getVerifierId(userInfo, this.typeOfLogin),
        verifier: this.verifier,
      };
    } catch (error) {
      log.error(error);
      const decodedToken: Auth0UserInfo = jwtDecode(idToken);
      const { name, email, picture } = decodedToken;
      return {
        profileImage: picture,
        name,
        email,
        verifierId: getVerifierId(decodedToken, this.typeOfLogin),
        verifier: this.verifier,
      };
    }
  }

  handleLoginWindow(): Promise<LoginWindowResponse> {
    return new Promise<LoginWindowResponse>((resolve, reject) => {
      if (this.redirectToOpener) {
        reject(new Error("Cannot use redirect to opener for passwordless"));
        return;
      }
      const handleData = (ev: { error: string; data: PopupResponse }) => {
        try {
          const { error, data } = ev;
          const {
            instanceParams: { verifier: returnedVerifier },
            hashParams: { access_token: accessToken, id_token: idToken },
          } = data || {};
          if (error) {
            log.error(ev.error);
            reject(new Error(error));
            return;
          }
          if (ev.data && returnedVerifier === this.verifier) {
            log.info(ev.data);
            resolve({ accessToken, idToken: idToken || "" });
          }
        } catch (error) {
          log.error(error);
          reject(error);
        }
      };
      const bc = new BroadcastChannel(`redirect_channel_${this.nonce}`, broadcastChannelOptions);
      bc.addEventListener("message", async (ev) => {
        handleData(ev);
        bc.close();
      });
      try {
        const { connection = "email", login_hint } = this.jwtParams;
        const finalJwtParams = deepmerge(
          {
            client_id: this.clientId,
            connection,
            email: connection === "email" ? login_hint : undefined,
            phone_number: connection === "sms" ? login_hint : undefined,
            send: "link",
            authParams: {
              scope: this.SCOPE,
              state: this.state,
              response_type: this.RESPONSE_TYPE,
              redirect_uri: this.redirect_uri,
              nonce: this.nonce,
              prompt: this.PROMPT,
            },
          },
          {
            authParams: this.jwtParams,
          }
        );
        // using stringify and parse to remove undefined params
        // This method is only resolved when the user clicks the email link
        post(this.finalURL.href, JSON.parse(JSON.stringify(finalJwtParams)))
          .then((response) => {
            log.info("posted", response);
            return undefined;
          })
          .catch((error) => {
            log.error(error);
            reject(error);
          });
      } catch (error) {
        log.error(error);
        reject(error);
      }
    });
  }
}