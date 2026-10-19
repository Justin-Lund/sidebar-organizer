import type { SidebarOrganizer } from '../sidebar-organizer';

import { CONFIG_NAME, NAMESPACE_TITLE, REPO_URL } from '@constants';
import { saveAccountConfig, validateAccountConfig } from '@utilities/account-config';
import { isItemsValid } from '@utilities/configs';
import { clearSidebarOrganizerStorage } from '@utilities/configs/misc';
import { clearBrowserCache, fileDownload, nextRender } from '@utilities/dom-utils';
import { CoreFrontendUserData, subscribeFrontendUserData } from '@utilities/index';
import { getDefaultPanelUrlPath } from '@utilities/panel';
import { UnsubscribeFunc } from 'home-assistant-js-websocket/dist/types';
import { css, html, LitElement, PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import YAML from 'yaml';

type ActionType = 'open_dialog' | 'clear_cache' | 'download_config' | 'delete_config';
const ACTION_LIST: {
  headline: string;
  supportingText?: string;
  action: ActionType;
  btnText?: string;
  variant?: string;
  canDisable?: boolean;
}[] = [
  {
    headline: 'Settings dialog',
    supportingText: 'Open the settings dialog to customize your sidebar.',
    action: 'open_dialog',
    btnText: 'Open',
    canDisable: false,
  },
  {
    headline: 'Clear frontend cache',
    supportingText: 'Clear the frontend cache to fix potential issues.',
    action: 'clear_cache',
    btnText: 'Clear',
    canDisable: false,
  },
  {
    headline: 'Download configuration',
    supportingText: 'Download the current configuration as a yaml file.',
    action: 'download_config',
    btnText: 'Download',
    canDisable: true,
  },
  {
    headline: 'Delete saved configuration',
    supportingText: "Delete the saved configuration in the browser's local storage.",
    action: 'delete_config',
    btnText: 'Delete',
    variant: 'danger',
    canDisable: true,
  },
] as const;

@customElement('so-profile-section')
export class SoProfileSection extends LitElement {
  @property({ attribute: false }) public organizer!: SidebarOrganizer;

  public _coreUserData?: CoreFrontendUserData | null;
  private _unsubCoreData?: Promise<UnsubscribeFunc>;
  private _accountChanged = () => this.requestUpdate();

  public connectedCallback() {
    super.connectedCallback();
    this.organizer._accountListeners.add(this._accountChanged);
    if (this.organizer.hass) {
      this._getCoreData();
    }
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this.organizer._accountListeners.delete(this._accountChanged);
    if (this._unsubCoreData) {
      this._unsubCoreData.then((unsub) => unsub());
      this._unsubCoreData = undefined;
    }
  }

  protected firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    if (!this._unsubCoreData) {
      this._getCoreData();
    }
  }
  public _getCoreData() {
    if (!this.organizer._pluginConfigured) {
      return;
    }
    const defaultPanel = getDefaultPanelUrlPath(this.organizer.hass);
    //info
    console.log(
      '%cSO-PROFILE-SECTION:%c ℹ️ Subscribing to core frontend user data',
      'color: #40c057;',
      'color: #228be6;',
      defaultPanel
    );

    this._unsubCoreData = subscribeFrontendUserData(this.organizer.hass.connection, 'core', async ({ value }) => {
      this._coreUserData = value;
      // console.log('%cSO-PROFILE-SECTION:', 'color: #4dabf7;', 'Received core frontend user data:', value);
      const userDefaultPanel = value?.default_panel;
      const hasChangeInDefaultPanel = Boolean(userDefaultPanel && defaultPanel !== userDefaultPanel);
      if (hasChangeInDefaultPanel) {
        console.log(
          '%cSO-PROFILE-SECTION:',
          'color: #4dabf7;',
          'User default panel changed to',
          userDefaultPanel,
          'from',
          defaultPanel
        );
        this.organizer._store._needReloadToast();
        return;
      }
      await nextRender();
      this.organizer._checkDiffs();
    });
  }

  protected render() {
    return html`
      <ha-card>
        <div class="card-header">
          ${NAMESPACE_TITLE}
          <ha-icon icon="mdi:github" @click=${() => window.open(`${REPO_URL}`, '_blank')}></ha-icon>
        </div>
        <div class="card-content">
          The following settings are used to control the behavior of the Sidebar Organizer plugin.
          <p>
            Account configuration: ${this.organizer._accountConfig.status}. Account layouts are stored in Home Assistant
            and loaded on every device after reload. Existing native sidebar preferences take priority. Group expansion
            lasts for this session.
          </p>
          <ha-button
            @click=${() => !this.organizer._accountManaged && this._publishAccountConfig()}
            .disabled=${!this.organizer._accountLoaded ||
            this.organizer._accountManaged ||
            !this.organizer._pluginConfigured}
          >
            Use current layout on all devices
          </ha-button>
          <ha-button .disabled=${!this.organizer._accountLoaded} @click=${() => this._uploadAccountConfig()}
            >Upload account configuration</ha-button
          >
          <ha-button
            @click=${() => this._removeAccountConfig()}
            .disabled=${!this.organizer._accountLoaded || !this.organizer._accountManaged}
            >Remove account configuration</ha-button
          >
        </div>
        <ha-md-list>
          ${ACTION_LIST.map((action) => {
            const isDisabled =
              (action.canDisable && !this.organizer._hasSidebarConfig) ||
              (action.action === 'delete_config' && this.organizer._accountManaged);
            return html`
              ${action.action === 'delete_config' ? html`<wa-divider style="--spacing: 0;"></wa-divider>` : ''}
              <ha-md-list-item>
                <span slot="headline">${action.headline}</span>
                ${action.supportingText ? html`<span slot="supporting-text">${action.supportingText}</span>` : ''}
                <ha-button
                  slot="end"
                  appearance="plain"
                  size="small"
                  variant=${action.variant || 'brand'}
                  .disabled=${isDisabled}
                  @click=${() => this._handleAction(action.action)}
                >
                  ${action.btnText}
                </ha-button>
              </ha-md-list-item>
            `;
          })}
        </ha-md-list>
      </ha-card>
    `;
  }

  private _handleAction = async (action: ActionType) => {
    switch (action) {
      case 'open_dialog':
        this.organizer._dialogManager._showConfigDialogEditor();
        break;
      case 'delete_config':
        const confirmed = await this.organizer._dialogManager._confirm(
          'Are you sure you want to delete the saved configuration? This action cannot be undone.',
          'Delete',
          'Cancel'
        );
        if (confirmed) {
          clearSidebarOrganizerStorage();
          if (!this.organizer._hasSidebarConfig) {
            this.organizer._reloadWindow(3000);
          }
        }
        break;
      case 'clear_cache':
        clearBrowserCache();
        break;
      case 'download_config':
        const yamlStr = YAML.stringify(this.organizer._config);
        // Create a blob from the data
        const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
        const url = URL.createObjectURL(blob);
        const filename = `${CONFIG_NAME + '_' + new Date().toISOString().replace(/:/g, '-').split('.', 1).join()}`;
        if (__DEBUG__) {
          fileDownload(url, `${filename}-dev.yaml`);
        } else {
          fileDownload(url, `${filename}.yaml`);
        }
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 0);
        break;
    }
  };

  private async _publishAccountConfig(config = this.organizer._config): Promise<void> {
    // Migration copies the fully loaded layout; upload uses the same validation
    // and confirmation path. Neither operation clears the legacy rollback copy.
    if (!this.organizer._accountLoaded) return;
    const connection = this.organizer.hass.connection;
    const user = this.organizer.hass.user?.id;
    try {
      const validated = validateAccountConfig(config);
      if (!(await isItemsValid(validated, this.organizer.hass))) {
        throw new Error('Configuration contains invalid or duplicated panel paths.');
      }
      if (
        !(await this.organizer._dialogManager._confirm(
          'Save this layout for your signed-in account on all devices? Other accounts and native sidebar preferences are unchanged.',
          'Save account layout',
          'Cancel'
        ))
      )
        return;
      // Validation and confirmation can outlive the session that opened them.
      // Never send the approved layout through a different account connection.
      if (this.organizer.hass.connection !== connection || this.organizer.hass.user?.id !== user)
        throw new Error('Account changed. Reload before saving.');
      await saveAccountConfig(connection, validated);
      this.organizer._reloadWindow();
    } catch (error) {
      await this.organizer._dialogManager._alert(`Account configuration was not saved: ${String(error)}`);
    }
  }

  private _uploadAccountConfig(): void {
    if (!this.organizer._accountLoaded) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.yaml,.yml';
    input.addEventListener(
      'change',
      async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          await this._publishAccountConfig(validateAccountConfig(YAML.parse(await file.text())));
        } catch (error) {
          await this.organizer._dialogManager._alert(`Invalid account configuration: ${String(error)}`);
        }
      },
      { once: true }
    );
    input.click();
  }

  private async _removeAccountConfig(): Promise<void> {
    if (!this.organizer._accountLoaded) return;
    const connection = this.organizer.hass.connection;
    const user = this.organizer.hass.user?.id;
    if (
      !(await this.organizer._dialogManager._confirm(
        'Remove the layout for your account on all devices? Each device will return to its existing local or file configuration after reload.',
        'Remove',
        'Cancel'
      ))
    )
      return;
    try {
      if (this.organizer.hass.connection !== connection || this.organizer.hass.user?.id !== user)
        throw new Error('Account changed.');
      await saveAccountConfig(connection, null);
      this.organizer._reloadWindow();
    } catch {
      await this.organizer._dialogManager._alert('Account configuration could not be removed. Reload and try again.');
    }
  }
  static styles = css`
    ha-card {
      margin: 0 auto var(--ha-space-4);
      max-width: 600px;
    }
    ha-card .card-header {
      display: flex;
      justify-content: space-between;
    }
    ha-card .card-header ha-icon {
      color: var(--secondary-text-color);
      cursor: pointer;
      &:hover {
        color: var(--primary-color);
      }
    }
    ha-md-list {
      background: 0 0;
      padding-top: 0;
      padding-bottom: 0;
    }
    /* .card-content {
    } */
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'so-profile-section': SoProfileSection;
  }
}
