import "@material/mwc-button";
import "@polymer/paper-dialog-scrollable/paper-dialog-scrollable";
import "../../components/ha-icon-button";
import "../../components/ha-circular-progress";
import "@polymer/paper-tooltip/paper-tooltip";
import type { UnsubscribeFunc } from "home-assistant-js-websocket";
import {
  css,
  CSSResultArray,
  customElement,
  html,
  LitElement,
  property,
  PropertyValues,
  TemplateResult,
} from "lit-element";
import "../../components/ha-dialog";
import "../../components/ha-form/ha-form";
import "../../components/ha-markdown";
import {
  AreaRegistryEntry,
  subscribeAreaRegistry,
} from "../../data/area_registry";
import type { DataEntryFlowStep } from "../../data/data_entry_flow";
import {
  DeviceRegistryEntry,
  subscribeDeviceRegistry,
} from "../../data/device_registry";
import { haStyleDialog } from "../../resources/styles";
import type { HomeAssistant } from "../../types";
import { DataEntryFlowDialogParams } from "./show-dialog-data-entry-flow";
import "./step-flow-abort";
import "./step-flow-create-entry";
import "./step-flow-external";
import "./step-flow-form";
import "./step-flow-loading";
import "./step-flow-pick-handler";

let instance = 0;

declare global {
  // for fire event
  interface HASSDomEvents {
    "flow-update": {
      step?: DataEntryFlowStep;
      stepPromise?: Promise<DataEntryFlowStep>;
    };
  }
}

@customElement("dialog-data-entry-flow")
class DataEntryFlowDialog extends LitElement {
  public hass!: HomeAssistant;

  @property() private _params?: DataEntryFlowDialogParams;

  @property() private _loading = true;

  private _instance = instance;

  @property() private _step:
    | DataEntryFlowStep
    | undefined
    // Null means we need to pick a config flow
    | null;

  @property() private _devices?: DeviceRegistryEntry[];

  @property() private _areas?: AreaRegistryEntry[];

  @property() private _handlers?: string[];

  private _unsubAreas?: UnsubscribeFunc;

  private _unsubDevices?: UnsubscribeFunc;

  public async showDialog(params: DataEntryFlowDialogParams): Promise<void> {
    this._params = params;
    this._instance = instance++;

    // Create a new config flow. Show picker
    if (!params.continueFlowId && !params.startFlowHandler) {
      if (!params.flowConfig.getFlowHandlers) {
        throw new Error("No getFlowHandlers defined in flow config");
      }
      this._step = null;

      // We only load the handlers once
      if (this._handlers === undefined) {
        this._loading = true;
        try {
          this._handlers = await params.flowConfig.getFlowHandlers(this.hass);
        } finally {
          this._loading = false;
        }
      }
      await this.updateComplete;
      return;
    }

    this._loading = true;
    const curInstance = this._instance;
    const step = await (params.continueFlowId
      ? params.flowConfig.fetchFlow(this.hass, params.continueFlowId)
      : params.flowConfig.createFlow(this.hass, params.startFlowHandler!));

    // Happens if second showDialog called
    if (curInstance !== this._instance) {
      return;
    }

    this._processStep(step);
    this._loading = false;
  }

  protected render(): TemplateResult {
    if (!this._params) {
      return html``;
    }

    return html`
      <ha-dialog
        open
        @closing=${this._close}
        scrimClickAction
        escapeKeyAction
        hideActions
      >
        <div>
          ${this._loading ||
          (this._step === null && this._handlers === undefined)
            ? html`
                <step-flow-loading
                  .label=${this.hass.localize(
                    "ui.panel.config.integrations.config_flow.loading_first_time"
                  )}
                ></step-flow-loading>
              `
            : this._step === undefined
            ? // When we are going to next step, we render 1 round of empty
              // to reset the element.
              ""
            : html`
                <ha-icon-button
                  aria-label=${this.hass.localize(
                    "ui.panel.config.integrations.config_flow.dismiss"
                  )}
                  icon="hass:close"
                  dialogAction="close"
                ></ha-icon-button>
                ${this._step === null
                  ? // Show handler picker
                    html`
                      <step-flow-pick-handler
                        .flowConfig=${this._params.flowConfig}
                        .hass=${this.hass}
                        .handlers=${this._handlers}
                        .showAdvanced=${this._params.showAdvanced}
                      ></step-flow-pick-handler>
                    `
                  : this._step.type === "form"
                  ? html`
                      <step-flow-form
                        .flowConfig=${this._params.flowConfig}
                        .step=${this._step}
                        .hass=${this.hass}
                      ></step-flow-form>
                    `
                  : this._step.type === "external"
                  ? html`
                      <step-flow-external
                        .flowConfig=${this._params.flowConfig}
                        .step=${this._step}
                        .hass=${this.hass}
                      ></step-flow-external>
                    `
                  : this._step.type === "abort"
                  ? html`
                      <step-flow-abort
                        .flowConfig=${this._params.flowConfig}
                        .step=${this._step}
                        .hass=${this.hass}
                      ></step-flow-abort>
                    `
                  : this._devices === undefined || this._areas === undefined
                  ? // When it's a create entry result, we will fetch device & area registry
                    html` <step-flow-loading></step-flow-loading> `
                  : html`
                      <step-flow-create-entry
                        .flowConfig=${this._params.flowConfig}
                        .step=${this._step}
                        .hass=${this.hass}
                        .devices=${this._devices}
                        .areas=${this._areas}
                      ></step-flow-create-entry>
                    `}
              `}
        </div>
      </ha-dialog>
    `;
  }

  protected firstUpdated(changedProps: PropertyValues) {
    super.firstUpdated(changedProps);
    this.addEventListener("flow-update", (ev) => {
      const { step, stepPromise } = (ev as any).detail;
      this._processStep(step || stepPromise);
    });
  }

  protected updated(changedProps: PropertyValues) {
    if (
      changedProps.has("_step") &&
      this._step &&
      this._step.type === "create_entry"
    ) {
      if (this._params!.flowConfig.loadDevicesAndAreas) {
        this._fetchDevices(this._step.result);
        this._fetchAreas();
      } else {
        this._devices = [];
        this._areas = [];
      }
    }
  }

  private async _fetchDevices(configEntryId) {
    this._unsubDevices = subscribeDeviceRegistry(
      this.hass.connection,
      (devices) => {
        this._devices = devices.filter((device) =>
          device.config_entries.includes(configEntryId)
        );
      }
    );
  }

  private async _fetchAreas() {
    this._unsubAreas = subscribeAreaRegistry(this.hass.connection, (areas) => {
      this._areas = areas;
    });
  }

  private async _processStep(
    step: DataEntryFlowStep | undefined | Promise<DataEntryFlowStep>
  ): Promise<void> {
    if (step instanceof Promise) {
      this._loading = true;
      try {
        this._step = await step;
      } finally {
        this._loading = false;
      }
      return;
    }

    if (step === undefined) {
      this._flowDone();
      return;
    }
    this._step = undefined;
    await this.updateComplete;
    this._step = step;
  }

  private _flowDone(): void {
    if (!this._params) {
      return;
    }
    const flowFinished = Boolean(
      this._step && ["create_entry", "abort"].includes(this._step.type)
    );

    // If we created this flow, delete it now.
    if (this._step && !flowFinished && !this._params.continueFlowId) {
      this._params.flowConfig.deleteFlow(this.hass, this._step.flow_id);
    }

    if (this._params.dialogClosedCallback) {
      this._params.dialogClosedCallback({
        flowFinished,
      });
    }

    this._step = undefined;
    this._params = undefined;
    this._devices = undefined;
    if (this._unsubAreas) {
      this._unsubAreas();
      this._unsubAreas = undefined;
    }
    if (this._unsubDevices) {
      this._unsubDevices();
      this._unsubDevices = undefined;
    }
  }

  private _close(): void {
    if (this._step) {
      this._flowDone();
    } else if (this._step === null) {
      // Flow aborted during picking flow
      this._step = undefined;
      this._params = undefined;
    }
  }

  static get styles(): CSSResultArray {
    return [
      haStyleDialog,
      css`
        ha-dialog {
          --dialog-content-padding: 0;
        }
        ha-icon-button {
          padding: 16px;
          position: absolute;
          top: 0;
          right: 0;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dialog-data-entry-flow": DataEntryFlowDialog;
  }
}
