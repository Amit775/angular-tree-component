import { DropEvent, IDType, ITreeEvent } from './../defs/api';
import { observable, computed, reaction, autorun, action, IReactionDisposer } from 'mobx';
import { TreeModel } from './tree.model';
import { TreeOptions } from './tree-options.model';
import { ITreeNode } from '../defs/api';
import { TREE_EVENTS } from '../constants/events';

import { first, last, some, every } from 'lodash-es';

export class TreeNode<T = any> implements ITreeNode {
  private handler: IReactionDisposer;
  @computed get isHidden(): boolean { return this.treeModel.isHidden(this); };
  @computed get isExpanded(): boolean { return this.treeModel.isExpanded(this); };
  @computed get isActive(): boolean { return this.treeModel.isActive(this); };
  @computed get isFocused(): boolean { return this.treeModel.isNodeFocused(this); };
  @computed get isSelected(): boolean {
    if (this.isSelectable()) {
      return this.treeModel.isSelected(this);
    } else {
      return some(this.children, (node: TreeNode) => node.isSelected);
    }
  };
  @computed get isAllSelected(): boolean {
    if (this.isSelectable()) {
      return this.treeModel.isSelected(this);
    } else {
      return every(this.children, (node: TreeNode) => node.isAllSelected);
    }
  };
  @computed get isPartiallySelected(): boolean {
    return this.isSelected && !this.isAllSelected;
  }

  @observable children: TreeNode[];
  @observable index: number;
  @observable position = 0;
  @observable height: number;
  @computed get level(): number {
    return this.parent ? this.parent.level + 1 : 0;
  }
  @computed get path(): IDType[] {
    return this.parent ? [...this.parent.path, this.id] : [];
  }

  get elementRef(): any {
    throw `Element Ref is no longer supported since introducing virtual scroll\n
      You may use a template to obtain a reference to the element`;
  }

  constructor(public data: T, public parent: TreeNode, public treeModel: TreeModel, index: number) {
    if (this.id === undefined || this.id === null) {
      this.id = uuid();
    } // Make sure there's a unique id without overriding existing ids to work with immutable data structures
    this.index = index;

    if (this.getField('children')) {
      this._initChildren();
    }
    this.autoLoadChildren();
  }

  // helper get functions:
  get hasChildren(): boolean {
    return !!(this.getField('hasChildren') || (this.children && this.children.length > 0));
  }
  get isCollapsed(): boolean { return !this.isExpanded; }
  get isLeaf(): boolean { return !this.hasChildren; }
  get isRoot(): boolean { return this.parent.data.virtual; }
  get realParent(): TreeNode { return this.isRoot ? null : this.parent; }

  // proxy functions:
  get options(): TreeOptions { return this.treeModel.options; }
  fireEvent(event: ITreeEvent): void { this.treeModel.fireEvent(event); }

  // field accessors:
  get displayField(): string {
    return this.getField('display');
  }

  get id(): IDType {
    return this.getField('id');
  }

  set id(value: IDType) {
    this.setField('id', value);
  }

  getField<V>(key: string): V {
    return this.data[this.options[`${key}Field`]];
  }

  setField<V>(key: string, value: V): void {
    this.data[this.options[`${key}Field`]] = value;
  }

  // traversing:
  _findAdjacentSibling(steps: number, skipHidden = false): TreeNode {
    const siblings = this._getParentsChildren(skipHidden);
    const index = siblings.indexOf(this);

    return siblings.length > index + steps ? siblings[index + steps] : null;
  }

  findNextSibling(skipHidden = false): TreeNode {
    return this._findAdjacentSibling(+1, skipHidden);
  }

  findPreviousSibling(skipHidden = false): TreeNode {
    return this._findAdjacentSibling(-1, skipHidden);
  }

  getVisibleChildren(): TreeNode[] {
    return this.visibleChildren;
  }

  @computed get visibleChildren(): TreeNode[] {
    return (this.children || []).filter((node) => !node.isHidden);
  }

  getFirstChild(skipHidden = false): TreeNode {
    let children = skipHidden ? this.visibleChildren : this.children;

    return first(children || []);
  }

  getLastChild(skipHidden = false): TreeNode {
    let children = skipHidden ? this.visibleChildren : this.children;

    return last(children || []);
  }

  findNextNode(goInside = true, skipHidden = false): TreeNode {
    return goInside && this.isExpanded && this.getFirstChild(skipHidden) ||
      this.findNextSibling(skipHidden) ||
      this.parent && this.parent.findNextNode(false, skipHidden);
  }

  findPreviousNode(skipHidden = false): TreeNode {
    let previousSibling = this.findPreviousSibling(skipHidden);
    if (!previousSibling) {
      return this.realParent;
    }
    return previousSibling._getLastOpenDescendant(skipHidden);
  }

  _getLastOpenDescendant(skipHidden = false): TreeNode {
    const lastChild = this.getLastChild(skipHidden);
    return (this.isCollapsed || !lastChild)
      ? this
      : lastChild._getLastOpenDescendant(skipHidden);
  }

  private _getParentsChildren(skipHidden = false): TreeNode[] {
    const children = this.parent &&
      (skipHidden ? this.parent.getVisibleChildren() : this.parent.children);

    return children || [];
  }

  getIndexInParent(skipHidden = false): number {
    return this._getParentsChildren(skipHidden).indexOf(this);
  }

  isDescendantOf(node: TreeNode): boolean {
    if (this === node) return true;
    else return this.parent && this.parent.isDescendantOf(node);
  }

  getNodePadding(): string {
    return this.options.levelPadding * (this.level - 1) + 'px';
  }

  getClass(): string {
    return [this.options.nodeClass(this), `tree-node-level-${this.level}`].join(' ');
  }

  onDrop($event: DropEvent): void {
    this.mouseAction('drop', $event.event, {
      from: $event.element,
      to: { parent: this, index: 0, dropOnNode: true }
    });
  }

  allowDrop = (element: TreeNode, $event?: DragEvent) => {
    return this.options.allowDrop(element, { parent: this, index: 0 }, $event);
  }

  allowDragoverStyling = () => {
    return this.options.allowDragoverStyling;
  }

  allowDrag(): boolean {
    return this.options.allowDrag(this);
  }


  // helper methods:
  async loadNodeChildren(): Promise<void> {
    if (!this.options.getChildren) {
      return Promise.resolve(); // Not getChildren method - for using redux
    }
    return Promise.resolve(this.options.getChildren(this))
      .then((children: TreeNode[]) => {
        if (children) {
          this.setField('children', children);
          this._initChildren();
          if (this.options.useTriState && this.treeModel.isSelected(this)) {
            this.setIsSelected(true);
          }
          this.children.forEach((child) => {
            if (child.getField('isExpanded') && child.hasChildren) {
              child.expand();
            }
          });
        }
      }).then(() => {
        this.fireEvent({
          eventName: TREE_EVENTS.loadNodeChildren,
          node: this
        });
      });
  }

  expand(): this {
    if (!this.isExpanded) {
      this.toggleExpanded();
    }

    return this;
  }

  collapse(): this {
    if (this.isExpanded) {
      this.toggleExpanded();
    }

    return this;
  }

  doForAll(fn: (node: ITreeNode) => any): void {
    Promise.resolve(fn(this)).then(() => {
      if (this.children) {
        this.children.forEach((child) => child.doForAll(fn));
      }
    });
  }

  expandAll(): void {
    this.doForAll((node) => node.expand());
  }

  collapseAll(): void {
    this.doForAll((node) => node.collapse());
  }

  ensureVisible(): this {
    if (this.realParent) {
      this.realParent.expand();
      this.realParent.ensureVisible();
    }

    return this;
  }

  toggleExpanded(): this {
    this.setIsExpanded(!this.isExpanded);

    return this;
  }

  setIsExpanded(value: boolean): this {
    if (this.hasChildren) {
      this.treeModel.setExpandedNode(this, value);
    }

    return this;
  };

  autoLoadChildren(): void {
    this.handler =
      reaction(
        () => this.isExpanded,
        (isExpanded) => {
          if (!this.children && this.hasChildren && isExpanded) {
            this.loadNodeChildren();
          }
        },
        { fireImmediately: true }
      );
  }

  dispose(): void {
    if (this.children) {
      this.children.forEach((child: TreeNode) => child.dispose());
    }
    if (this.handler) {
      this.handler();
    }
    this.parent = null;
    this.children = null;
  }

  setIsActive(value: boolean, multi = false): this {
    this.treeModel.setActiveNode(this, value, multi);
    if (value) {
      this.focus(this.options.scrollOnActivate);
    }

    return this;
  }

  isSelectable(): boolean {
    return this.isLeaf || !this.children || !this.options.useTriState;
  }

  @action setIsSelected(value: boolean): this {
    if (this.isSelectable()) {
      this.treeModel.setSelectedNode(this, value);
    } else {
      this.visibleChildren.forEach((child: TreeNode) => child.setIsSelected(value));
    }

    return this;
  }

  toggleSelected(): this {
    this.setIsSelected(!this.isSelected);

    return this;
  }

  toggleActivated(multi = false): this {
    this.setIsActive(!this.isActive, multi);

    return this;
  }

  setActiveAndVisible(multi = false): this {
    this.setIsActive(true, multi)
      .ensureVisible();

    setTimeout(this.scrollIntoView.bind(this));

    return this;
  }

  scrollIntoView(force = false): void {
    this.treeModel.virtualScroll.scrollIntoView(this, force);
  }

  focus(scroll = true): this {
    let previousNode = this.treeModel.getFocusedNode();
    this.treeModel.setFocusedNode(this);
    if (scroll) {
      this.scrollIntoView();
    }
    if (previousNode) {
      this.fireEvent({ eventName: TREE_EVENTS.blur, node: previousNode });
    }
    this.fireEvent({ eventName: TREE_EVENTS.focus, node: this });

    return this;
  }

  blur(): this {
    let previousNode = this.treeModel.getFocusedNode();
    this.treeModel.setFocusedNode(null);
    if (previousNode) {
      this.fireEvent({ eventName: TREE_EVENTS.blur, node: this });
    }

    return this;
  }

  setIsHidden(value: boolean): void {
    this.treeModel.setIsHidden(this, value);
  }

  hide(): void {
    this.setIsHidden(true);
  }

  show(): void {
    this.setIsHidden(false);
  }

  mouseAction<E>(actionName: string, $event?: MouseEvent, data: E = null): void {
    this.treeModel.setFocus(true);

    const actionMapping = this.options.actionMapping.mouse;
    const mouseAction = actionMapping[actionName];

    if (mouseAction) {
      mouseAction(this.treeModel, this, $event, data);
    }
  }

  getSelfHeight(): number {
    return this.options.nodeHeight(this);
  }

  @action _initChildren(): void {
    this.children = this.getField<TreeNode[]>('children')
      .map((child: TreeNode, index: number) => new TreeNode(child, this, this.treeModel, index));
  }
}

function uuid(): number {
  return Math.floor(Math.random() * 10000000000000);
}
